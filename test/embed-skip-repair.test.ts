/**
 * Schema migration v282 — repair of frontmatter that a double-encoded
 * `markEmbedSkip` turned into an array on Postgres. The shape is seeded
 * directly (PGLite never writes it); the Postgres half, including the write
 * that caused it, is test/e2e/mark-embed-skip-postgres.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { EMBED_SKIP_KEY, buildChunkTokenLimitMarker, isEmbedSkipped } from '../src/core/embed-skip.ts';
import { EMBED_SKIP_REPAIR_ATTEMPTS, doubleEncodedEmbedSkipMarker, repairEmbedSkipFrontmatter } from '../src/core/embed-skip-repair.ts';
import { v282 } from '../src/core/schema-migrations/v282-fork-repair-embed-skip-frontmatter.ts';

const AT = new Date('2026-10-26T22:28:00.000Z');
const patch = (bytes: number) => JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(bytes, AT) });
const rawPatch = (marker: unknown) => JSON.stringify({ [EMBED_SKIP_KEY]: marker });
const marker = buildChunkTokenLimitMarker(1, AT);

describe('doubleEncodedEmbedSkipMarker', () => {
  test('returns the last marker of the double-encoded shape', () => {
    expect(doubleEncodedEmbedSkipMarker([{ a: 1 }, patch(1)])?.bytes).toBe(1);
    expect(doubleEncodedEmbedSkipMarker([{ a: 1 }, patch(1), patch(2), patch(3)])?.bytes).toBe(3);
  });

  test('rejects every other shape', () => {
    for (const value of [
      { a: 1 },
      [{ a: 1 }],
      [patch(1), patch(2)],
      [{ a: 1 }, { [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(1) }],
      [{ a: 1 }, 'not json'],
      [{ a: 1 }, JSON.stringify({ other: {} })],
      [{ a: 1 }, JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(1), extra: 1 })],
      [{ a: 1 }, JSON.stringify({ [EMBED_SKIP_KEY]: 'flat' })],
      // `embed_skip` objects that are not the marker the parking path writes.
      [{ keep: 'foreign' }, rawPatch({ unrelated: 'payload' })],
      [{ a: 1 }, rawPatch({ ...marker, extra: 1 })],
      [{ a: 1 }, rawPatch({ reason: marker.reason, bytes: marker.bytes })],
      [{ a: 1 }, rawPatch({ ...marker, reason: 'oversized' })],
      [{ a: 1 }, rawPatch({ ...marker, bytes: '10' })],
      [{ a: 1 }, rawPatch({ ...marker, bytes: -1 })],
      [{ a: 1 }, rawPatch({ ...marker, bytes: 1.5 })],
      [{ a: 1 }, rawPatch({ ...marker, assessed_at: 'yesterday' })],
      [{ a: 1 }, rawPatch({ ...marker, assessed_at: '2026-10-27' })],
      [{ a: 1 }, patch(1), rawPatch({ unrelated: 'payload' })],
      [{ a: 1 }, patch(1), 7],
      ['x', 'y'],
    ]) expect(doubleEncodedEmbedSkipMarker(value)).toBeUndefined();
  });
});

describe('v282 repair (PGLite)', () => {
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

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM pages');
  });

  async function seed(slug: string, frontmatter: unknown): Promise<void> {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body', timeline: '', frontmatter: {} } as any);
    await engine.executeRaw('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', [slug, JSON.stringify(frontmatter)]);
  }

  async function frontmatterOf(slug: string): Promise<{ type: string; value: unknown }> {
    const [row] = await engine.executeRaw<{ type: string; value: string }>(
      'SELECT jsonb_typeof(frontmatter) AS type, frontmatter::text AS value FROM pages WHERE slug = $1', [slug]);
    return { type: row!.type, value: JSON.parse(row!.value) };
  }

  test('collapses a 2-element and a many-element array, leaves a foreign array alone', async () => {
    const original = { id: 'ext-42', tags: ['a', 'b'], nested: { keep: true } };
    await seed('two', [original, patch(10)]);
    await seed('many', [original, patch(1), patch(2), patch(3), patch(4)]);
    const foreign = [{ id: 'x' }, 'plain string', 3];
    await seed('foreign', foreign);
    await seed('normal', { keep: 'me' });

    await seed('foreign-marker', [{ keep: 'foreign' }, rawPatch({ unrelated: 'payload' })]);

    expect(await repairEmbedSkipFrontmatter(engine)).toEqual({
      repaired: 2,
      untouched: [{ source_id: 'default', slug: 'foreign' }, { source_id: 'default', slug: 'foreign-marker' }],
      gitCanonical: [],
    });

    for (const [slug, bytes] of [['two', 10], ['many', 4]] as const) {
      const fm = await frontmatterOf(slug);
      expect(fm.type).toBe('object');
      const value = fm.value as Record<string, any>;
      expect(value.id).toBe('ext-42');
      expect(value.tags).toEqual(['a', 'b']);
      expect(value.nested).toEqual({ keep: true });
      expect(isEmbedSkipped(value)).toBe(true);
      expect(value[EMBED_SKIP_KEY].bytes).toBe(bytes);
    }
    expect((await frontmatterOf('foreign')).value).toEqual(foreign);
    expect((await frontmatterOf('foreign-marker')).value).toEqual([{ keep: 'foreign' }, rawPatch({ unrelated: 'payload' })]);
    expect((await frontmatterOf('normal')).value).toEqual({ keep: 'me' });
  });

  test('is idempotent: a second run repairs nothing and changes nothing', async () => {
    await seed('two', [{ a: 1 }, patch(5)]);
    await v282.handler!(engine);
    const after = await frontmatterOf('two');
    expect(await repairEmbedSkipFrontmatter(engine)).toEqual({ repaired: 0, untouched: [], gitCanonical: [] });
    expect(await frontmatterOf('two')).toEqual(after);
  });

  test('repairs on a managed brain through the writer guard', async () => {
    await seed('managed', [{ keep: 'canonical' }, patch(9)]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      // The guard is live: an ungranted frontmatter write is refused.
      await expect(engine.executeRaw(`UPDATE pages SET frontmatter = '{}'::jsonb WHERE slug = 'managed'`)).rejects.toThrow();
      expect((await repairEmbedSkipFrontmatter(engine)).repaired).toBe(1);
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
    const value = (await frontmatterOf('managed')).value as Record<string, any>;
    expect(value.keep).toBe('canonical');
    expect(value[EMBED_SKIP_KEY].bytes).toBe(9);
  });
  /** The engine with `write` run (through the real engine) just before each repair UPDATE, up to `times` times. */
  function interleaved(write: () => Promise<unknown>, times: number): PGLiteEngine {
    let left = times;
    return new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
        return async (sql: string, params?: unknown[]) => {
          if (left > 0 && /^\s*UPDATE pages SET frontmatter/.test(sql)) { left--; await write(); }
          return target.executeRaw(sql, params);
        };
      },
    });
  }

  const appendPark = (slug: string, bytes: number) => () =>
    engine.executeRaw('UPDATE pages SET frontmatter = frontmatter || to_jsonb($2::text) WHERE slug = $1', [slug, patch(bytes)]);

  test('a row changed under the repair is re-read and repaired with its newest marker', async () => {
    await seed('raced', [{ keep: 'me' }, patch(1)]);
    const result = await repairEmbedSkipFrontmatter(interleaved(appendPark('raced', 2), 1));
    expect(result).toEqual({ repaired: 1, untouched: [], gitCanonical: [] });
    expect((await frontmatterOf('raced')).value).toEqual({ keep: 'me', [EMBED_SKIP_KEY]: JSON.parse(patch(2))[EMBED_SKIP_KEY] });
  });

  test('a row that keeps changing fails the migration and is not rewritten', async () => {
    await seed('busy', [{ keep: 'me' }, patch(1)]);
    let bytes = 10;
    const racer = interleaved(() => appendPark('busy', bytes++)(), EMBED_SKIP_REPAIR_ATTEMPTS);
    await expect(v282.handler!(racer)).rejects.toThrow(/default\/busy kept changing/);
    const fm = await frontmatterOf('busy');
    expect(fm.type).toBe('array');
    expect((fm.value as unknown[]).length).toBe(2 + EMBED_SKIP_REPAIR_ATTEMPTS);
    // Nothing else is writing now, so the next run repairs it.
    expect((await repairEmbedSkipFrontmatter(engine)).repaired).toBe(1);
  });

  test('leaves a damaged page in a managed git-canonical source and reports it', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('notes-git', 'notes-git', '{"canonical":"git"}'::jsonb)`);
    await engine.putPage('in-git', { type: 'note', title: 'in-git', compiled_truth: 'body', timeline: '', frontmatter: {} } as any, { sourceId: 'notes-git' } as any);
    const damaged = [{ keep: 'git' }, patch(4)];
    await engine.executeRaw(`UPDATE pages SET frontmatter = $1::text::jsonb WHERE slug = 'in-git' AND source_id = 'notes-git'`, [JSON.stringify(damaged)]);
    await seed('plain', [{ keep: 'plain' }, patch(5)]);
    const [{ strict }] = await engine.executeRaw<{ strict: number }>('SELECT strict_sources AS strict FROM git_canonical_brain WHERE singleton = 1');
    expect(Number(strict)).toBe(1);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      // The fence is live: the repair's own grant is not enough for this source.
      await expect(engine.executeRaw(
        `UPDATE pages SET frontmatter = '{}'::jsonb WHERE slug = 'in-git' AND set_config('gbrain.write_sources', '["notes-git"]', true) IS NOT NULL`,
      )).rejects.toThrow(/git_protocol_required/);
      await v282.handler!(engine);
      expect(await repairEmbedSkipFrontmatter(engine)).toEqual({
        repaired: 0, untouched: [], gitCanonical: [{ source_id: 'notes-git', slug: 'in-git' }],
      });
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'notes-git'`);
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'notes-git'`);
    }
    expect((await frontmatterOf('plain')).value).toEqual({ keep: 'plain', [EMBED_SKIP_KEY]: JSON.parse(patch(5))[EMBED_SKIP_KEY] });
  });
});
