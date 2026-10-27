/**
 * scripts/repair-embed-skip-frontmatter.ts against PGLite. The Postgres half
 * (rows produced by the real legacy double-encode) is
 * test/e2e/embed-skip-jsonb-postgres.test.ts; both run the same cases.
 */
import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { EMBED_SKIP_KEY, buildChunkTokenLimitMarker } from '../src/core/embed-skip.ts';
import { defineRepairCases } from './helpers/embed-skip-repair-cases.ts';
import { repairEmbedSkipFrontmatter, repairRow, stillDamaged, describeTarget, renderReport } from '../scripts/repair-embed-skip-frontmatter.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

async function insertPage(slug: string, frontmatterJson: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter)
     VALUES ($1, 'note', $1, 'body', '', $2::text::jsonb)`,
    [slug, frontmatterJson],
  );
}

defineRepairCases({
  engine: () => engine,
  reset: async () => { await engine.executeRaw('DELETE FROM pages'); },
  seedDamaged: async (slug, original, markerBytes) => {
    const markers = markerBytes.map(b => JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(b) }));
    await insertPage(slug, JSON.stringify([original, ...markers]));
  },
  seedRaw: async (slug, value) => { await insertPage(slug, JSON.stringify(value)); },
});

async function readType(slug: string, source = 'default'): Promise<string> {
  const rows = await engine.executeRaw<{ t: string }>(
    `SELECT jsonb_typeof(frontmatter) AS t FROM pages WHERE slug = $1 AND source_id = $2`, [slug, source]);
  return rows[0].t;
}

describe('repair-embed-skip-frontmatter on a brain that guards canonical writes', () => {
  test('rows of a guarded source are skipped and reported, the run continues, and it is still damaged', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw(`DELETE FROM sources WHERE id IN ('a-locked', 'z-open')`);
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('a-locked', 'a-locked'), ('z-open', 'z-open')`);
    const damaged = (n: number) => JSON.stringify([{ keep: 'me' }, JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(n) })]);
    for (const [source, slug] of [['a-locked', 'locked/page'], ['z-open', 'open/page']]) {
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
         VALUES ($1, $2, 'note', $2, 'body', '', $3::text::jsonb)`, [source, slug, damaged(9)]);
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.executeRaw(`SELECT set_config('gbrain.write_sources', '["z-open"]', false)`);
    try {
      const report = await repairEmbedSkipFrontmatter(engine, { apply: true });
      expect(report.repaired).toBe(1);
      expect(report.repairedRows.map(r => r.slug)).toEqual(['open/page']);
      expect(report.skipped.map(r => `${r.source_id}/${r.slug}`)).toEqual(['a-locked/locked/page']);
      expect(stillDamaged(report)).toBe(1);
      expect(renderReport(report)).toContain('persistence coordinator');
    } finally {
      await engine.executeRaw(`SELECT set_config('gbrain.write_sources', '', false)`);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
    expect(await readType('locked/page', 'a-locked')).toBe('array');
    expect(await readType('open/page', 'z-open')).toBe('object');
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw(`DELETE FROM sources WHERE id IN ('a-locked', 'z-open')`);
  });
});

describe('a row that moved between classification and update', () => {
  const marker = (n: number) => JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(n) });

  test('is re-read and repaired with its current length, then counted once', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await insertPage('moved/damaged', JSON.stringify([{ keep: 'me' }, marker(1), marker(2)]));
    const [row] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'moved/damaged'`);
    // Classified when it still had 2 elements; it has 3 now.
    const outcome = await engine.transaction(tx => repairRow(tx, { id: Number(row.id), source_id: 'default', slug: 'moved/damaged', elements: 2 }));
    expect(outcome).toBe('repaired');
    expect(await readType('moved/damaged')).toBe('object');
  });

  test('that is no longer damaged is not counted as repaired and is not modified', async () => {
    await engine.executeRaw('DELETE FROM pages');
    await insertPage('moved/object', JSON.stringify({ keep: 'me' }));
    await insertPage('moved/foreign', JSON.stringify([{ a: 1 }, 'not a marker']));
    const rows = await engine.executeRaw<{ id: number; slug: string }>(`SELECT id, slug FROM pages ORDER BY slug`);
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.slug] = await engine.transaction(tx => repairRow(tx, { id: Number(r.id), source_id: 'default', slug: r.slug, elements: 2 }));
    }
    expect(out).toEqual({ 'moved/foreign': 'foreign', 'moved/object': 'resolved' });
    expect(await readType('moved/object')).toBe('object');
    expect(await readType('moved/foreign')).toBe('array');
  });
});

/** A synthetic connection URL assembled from parts, so no credential-shaped literal sits in the source. */
function syntheticUrl(host: string, db: string, opts: { port?: string; user?: string; secret?: string; query?: string } = {}): string {
  const u = new URL(`postgresql://${host}:${opts.port ?? '5432'}/${db}`);
  if (opts.user) u.username = opts.user;
  if (opts.secret) u.password = opts.secret;
  if (opts.query) u.search = opts.query;
  return u.toString();
}

describe('target resolution', () => {
  const script = resolve(import.meta.dir, '../scripts/repair-embed-skip-frontmatter.ts');
  let home: string;
  let cwd: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'repair-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'repair-cwd-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
  });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });

  /** Runs the script's own resolution + identity code in a fresh process, as the operator would. */
  function resolveIn(extraEnv: Record<string, string>, dotenv?: string): { engine: string; location: string } {
    if (dotenv !== undefined) writeFileSync(join(cwd, '.env'), dotenv);
    else rmSync(join(cwd, '.env'), { force: true });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL' && k !== 'GBRAIN_DATABASE_URL') env[k] = v;
    const run = Bun.spawnSync({
      cmd: ['bun', '-e', `import { resolveTargetConfig, describeTarget } from ${JSON.stringify(script)}; console.log(JSON.stringify(describeTarget(resolveTargetConfig()!)));`],
      cwd,
      env: { ...env, GBRAIN_HOME: home, ...extraEnv },
    });
    expect(run.exitCode).toBe(0);
    return JSON.parse(run.stdout.toString().trim().split('\n').pop()!);
  }

  test('GBRAIN_DATABASE_URL wins over a plain DATABASE_URL, as for every other gbrain command', () => {
    const t = resolveIn({
      GBRAIN_DATABASE_URL: syntheticUrl('primary.example', 'brain_main', { user: 'u1', secret: 'secret-one' }),
      DATABASE_URL: syntheticUrl('other.example', 'other_db', { user: 'u2', secret: 'secret-two' }),
    });
    expect(t).toEqual({ engine: 'postgres', location: 'primary.example:5432/brain_main' });
  });

  test('a DATABASE_URL that only came from the working directory .env is ignored in favor of the configured brain', () => {
    const leaked = syntheticUrl('app.example', 'app_db', { user: 'u3', secret: 'secret-three' });
    const t = resolveIn({ DATABASE_URL: leaked }, `DATABASE_URL=${leaked}\n`);
    expect(t.engine).toBe('pglite');
    expect(t.location).toBe(join(home, 'brain.pglite'));
  });

  test('without any URL the configured brain under GBRAIN_HOME is the target', () => {
    expect(resolveIn({})).toEqual({ engine: 'pglite', location: join(home, 'brain.pglite') });
  });

  test('the printed identity carries no credentials or query string', () => {
    const id = describeTarget({ engine: 'postgres', database_url: syntheticUrl('db.example', 'brain', { port: '6543', user: 'u4', secret: 'secret-four', query: '?sslmode=require&password=x' }) });
    expect(JSON.stringify(id)).not.toMatch(/secret-four|u4|sslmode|password/);
    expect(id.location).toBe('db.example:6543/brain');
  });
});

describe('command line', () => {
  let home: string;
  let dbPath: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'repair-cli-'));
    dbPath = join(home, 'brain.pglite');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath }));
    const brain = new PGLiteEngine();
    await brain.connect({ database_path: dbPath });
    await brain.initSchema();
    const marker = JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(11) });
    await brain.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter)
       VALUES ('cli/damaged', 'note', 'cli/damaged', 'body', '', $1::text::jsonb)`,
      [JSON.stringify([{ keep: 'me' }, marker])],
    );
    await brain.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await brain.disconnect();
  }, 120_000);
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  function run(...args: string[]) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL' && k !== 'GBRAIN_DATABASE_URL') env[k] = v;
    const r = Bun.spawnSync({
      cmd: ['bun', resolve(import.meta.dir, '../scripts/repair-embed-skip-frontmatter.ts'), ...args],
      env: { ...env, GBRAIN_HOME: home },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test('a dry run prints the target identity first, lists the damaged row and exits 0', () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.err).toContain(`target: pglite ${dbPath} (1 pages)`);
    expect(r.out).toContain('cli/damaged');
  });

  test('--apply on rows the writer guard reserves exits non-zero, names them as skipped and changes nothing', () => {
    const r = run('--apply');
    expect(r.code).toBe(1);
    expect(r.err).toContain('target: pglite');
    expect(r.out).toContain('skipped, reserved for the persistence coordinator (left damaged): 1');
    expect(r.out).toContain('cli/damaged');
    expect(run().out).toContain('would repair: 1');
  });
});
