/**
 * `markEmbedSkip` and the v282 repair against real Postgres.
 *
 * postgres.js serializes a string bound to `::jsonb` a second time, so the
 * marker patch arrived as a jsonb string and `object || string` turned the
 * whole frontmatter into an array. PGLite hides that (its unit pair is
 * test/mark-embed-skip-engine.test.ts), so only this file proves the write.
 *
 * Run: DATABASE_URL=... bun test test/e2e/mark-embed-skip-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { EMBED_SKIP_KEY, buildChunkTokenLimitMarker, isEmbedSkipped } from '../../src/core/embed-skip.ts';
import { EMBED_SKIP_REPAIR_ATTEMPTS, repairEmbedSkipFrontmatter } from '../../src/core/embed-skip-repair.ts';
import { v282 } from '../../src/core/schema-migrations/v282-fork-repair-embed-skip-frontmatter.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const AT = new Date('2026-10-26T22:28:00.000Z');
const patch = (bytes: number) => JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(bytes, AT) });
const markerOf = (bytes: number) => JSON.parse(patch(bytes))[EMBED_SKIP_KEY];

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping markEmbedSkip Postgres E2E (DATABASE_URL not set)');

describeE2E('markEmbedSkip + v282 repair (Postgres)', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => { await getConn().unsafe('DELETE FROM pages'); });

  async function seed(slug: string, frontmatter: Record<string, unknown>): Promise<void> {
    await getEngine().putPage(slug, { type: 'note', title: slug, compiled_truth: 'body', timeline: '', frontmatter } as any);
  }

  async function read(slug: string): Promise<{ type: string; value: any; marker: string | null }> {
    const [row] = await getConn().unsafe(
      `SELECT jsonb_typeof(frontmatter) AS type, frontmatter::text AS value,
              frontmatter -> '${EMBED_SKIP_KEY}' ->> 'reason' AS marker
         FROM pages WHERE slug = $1`, [slug]);
    return { type: row.type, value: JSON.parse(row.value), marker: row.marker };
  }

  test('keeps every original key, stays an object and makes embed_skip readable', async () => {
    await seed('parked', { id: 'ext-42', domain: 'ops', tags: ['a'], content_flag: { reason: 'markup_heavy' } });
    await getEngine().markEmbedSkip('parked', { marker: buildChunkTokenLimitMarker(6057) });
    await getEngine().markEmbedSkip('parked', { marker: buildChunkTokenLimitMarker(7000) });

    const fm = await read('parked');
    expect(fm.type).toBe('object');
    expect(fm.marker).toBe('chunk_token_limit');
    expect(fm.value.id).toBe('ext-42');
    expect(fm.value.domain).toBe('ops');
    expect(fm.value.tags).toEqual(['a']);
    expect(fm.value.content_flag).toEqual({ reason: 'markup_heavy' });
    expect(fm.value[EMBED_SKIP_KEY].bytes).toBe(7000);
    expect(isEmbedSkipped(fm.value)).toBe(true);
  });

  test('a parked page drops out of stale-chunk selection', async () => {
    await seed('stale', { keep: 'me' });
    await getEngine().upsertChunks('stale', [{ chunk_index: 0, chunk_text: 'unembedded', chunk_source: 'compiled_truth' }] as any);
    expect(await getEngine().countStaleChunks()).toBe(1);
    await getEngine().markEmbedSkip('stale', { marker: buildChunkTokenLimitMarker(10) });
    expect(await getEngine().countStaleChunks()).toBe(0);
  });

  test('repairs the damaged 2- and many-element shapes, leaves a foreign array alone', async () => {
    const original = { id: 'ext-1', tags: ['x'], nested: { keep: true } };
    const foreign = [{ id: 'f' }, 'plain', 3];
    const foreignMarker = [{ keep: 'foreign' }, JSON.stringify({ [EMBED_SKIP_KEY]: { unrelated: 'payload' } })];
    for (const slug of ['two', 'many', 'foreign', 'foreign-marker']) await seed(slug, {});
    const conn = getConn();
    await conn.unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', ['two', JSON.stringify([original, patch(10)])]);
    await conn.unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', ['many', JSON.stringify([original, patch(1), patch(2), patch(3)])]);
    await conn.unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', ['foreign', JSON.stringify(foreign)]);
    await conn.unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', ['foreign-marker', JSON.stringify(foreignMarker)]);

    expect(await repairEmbedSkipFrontmatter(getEngine())).toEqual({
      repaired: 2,
      untouched: [{ source_id: 'default', slug: 'foreign' }, { source_id: 'default', slug: 'foreign-marker' }],
      gitCanonical: [],
    });
    for (const [slug, bytes] of [['two', 10], ['many', 3]] as const) {
      const fm = await read(slug);
      expect(fm.type).toBe('object');
      expect(fm.value).toEqual({ ...original, [EMBED_SKIP_KEY]: fm.value[EMBED_SKIP_KEY] });
      expect(fm.value[EMBED_SKIP_KEY].bytes).toBe(bytes);
    }
    expect((await read('foreign')).value).toEqual(foreign);
    expect((await read('foreign-marker')).value).toEqual(foreignMarker);
    expect((await repairEmbedSkipFrontmatter(getEngine())).repaired).toBe(0);
  });
  /** The engine with a second-connection write committed just before each repair UPDATE, up to `times` times. */
  function interleaved(write: () => Promise<unknown>, times: number): BrainEngine {
    const engine = getEngine();
    let left = times;
    return new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop !== 'executeRaw') return Reflect.get(target, prop, receiver);
        return async (sql: string, params?: unknown[]) => {
          if (left > 0 && /^\s*UPDATE pages SET frontmatter/.test(sql)) { left--; await write(); }
          return target.executeRaw(sql, params);
        };
      },
    }) as BrainEngine;
  }
  const appendPark = (slug: string, bytes: number) => () =>
    getConn().unsafe('UPDATE pages SET frontmatter = frontmatter || to_jsonb($2::text) WHERE slug = $1', [slug, patch(bytes)]);

  async function damage(slug: string, value: unknown[]): Promise<void> {
    await getConn().unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', [slug, JSON.stringify(value)]);
  }

  test('re-reads a row changed under the repair; fails without rewriting when it keeps changing', async () => {
    await seed('raced', {});
    await damage('raced', [{ keep: 'me' }, patch(1)]);
    expect(await repairEmbedSkipFrontmatter(interleaved(appendPark('raced', 2), 1)))
      .toEqual({ repaired: 1, untouched: [], gitCanonical: [] });
    expect((await read('raced')).value).toEqual({ keep: 'me', [EMBED_SKIP_KEY]: markerOf(2) });

    await seed('busy', {});
    await damage('busy', [{ keep: 'me' }, patch(1)]);
    let bytes = 10;
    await expect(v282.handler!(interleaved(() => appendPark('busy', bytes++)(), EMBED_SKIP_REPAIR_ATTEMPTS)))
      .rejects.toThrow(/default\/busy kept changing/);
    const fm = await read('busy');
    expect(fm.type).toBe('array');
    expect(fm.value.length).toBe(2 + EMBED_SKIP_REPAIR_ATTEMPTS);
  });

  test('leaves a damaged page in a managed git-canonical source and reports it', async () => {
    const conn = getConn();
    await conn.unsafe(`INSERT INTO sources (id, name, config) VALUES ('notes-git', 'notes-git', '{"canonical":"git"}'::jsonb)`);
    try {
      await getEngine().putPage('in-git', { type: 'note', title: 'in-git', compiled_truth: 'body', timeline: '', frontmatter: {} } as any, { sourceId: 'notes-git' } as any);
      const damaged = [{ keep: 'git' }, patch(4)];
      await conn.unsafe(`UPDATE pages SET frontmatter = $1::text::jsonb WHERE source_id = 'notes-git'`, [JSON.stringify(damaged)]);
      await seed('plain', {});
      await damage('plain', [{ keep: 'plain' }, patch(5)]);
      await conn.unsafe('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await expect(conn.begin(tx => tx.unsafe(
          `UPDATE pages SET frontmatter = '{}'::jsonb WHERE source_id = 'notes-git' AND set_config('gbrain.write_sources', '["notes-git"]', true) IS NOT NULL`,
        ))).rejects.toThrow(/git_protocol_required/);
        await v282.handler!(getEngine());
      } finally {
        await conn.unsafe('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
      expect(await repairEmbedSkipFrontmatter(getEngine())).toEqual({
        repaired: 0, untouched: [], gitCanonical: [{ source_id: 'notes-git', slug: 'in-git' }],
      });
      const [row] = await conn.unsafe(`SELECT frontmatter::text AS v FROM pages WHERE source_id = 'notes-git'`);
      expect(JSON.parse(row.v)).toEqual(damaged);
      expect((await read('plain')).value).toEqual({ keep: 'plain', [EMBED_SKIP_KEY]: markerOf(5) });
    } finally {
      await conn.unsafe(`DELETE FROM pages WHERE source_id = 'notes-git'`);
      await conn.unsafe(`DELETE FROM sources WHERE id = 'notes-git'`);
    }
  });
});
