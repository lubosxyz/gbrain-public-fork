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
import { repairEmbedSkipFrontmatter } from '../../src/core/embed-skip-repair.ts';

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
    const patch = (bytes: number) => JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(bytes) });
    const original = { id: 'ext-1', tags: ['x'], nested: { keep: true } };
    const foreign = [{ id: 'f' }, 'plain', 3];
    for (const slug of ['two', 'many', 'foreign']) await seed(slug, {});
    const conn = getConn();
    await conn.unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', ['two', JSON.stringify([original, patch(10)])]);
    await conn.unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', ['many', JSON.stringify([original, patch(1), patch(2), patch(3)])]);
    await conn.unsafe('UPDATE pages SET frontmatter = $2::text::jsonb WHERE slug = $1', ['foreign', JSON.stringify(foreign)]);

    expect(await repairEmbedSkipFrontmatter(getEngine())).toEqual({ repaired: 2, untouched: [{ source_id: 'default', slug: 'foreign' }] });
    for (const [slug, bytes] of [['two', 10], ['many', 3]] as const) {
      const fm = await read(slug);
      expect(fm.type).toBe('object');
      expect(fm.value).toEqual({ ...original, [EMBED_SKIP_KEY]: fm.value[EMBED_SKIP_KEY] });
      expect(fm.value[EMBED_SKIP_KEY].bytes).toBe(bytes);
    }
    expect((await read('foreign')).value).toEqual(foreign);
    expect((await repairEmbedSkipFrontmatter(getEngine())).repaired).toBe(0);
  });
});
