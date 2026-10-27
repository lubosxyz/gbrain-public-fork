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
import { doubleEncodedEmbedSkipMarker, repairEmbedSkipFrontmatter } from '../src/core/embed-skip-repair.ts';
import { v282 } from '../src/core/schema-migrations/v282-fork-repair-embed-skip-frontmatter.ts';

const patch = (bytes: number) => JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(bytes) });

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

    expect(await repairEmbedSkipFrontmatter(engine)).toEqual({ repaired: 2, untouched: [{ source_id: 'default', slug: 'foreign' }] });

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
    expect((await frontmatterOf('normal')).value).toEqual({ keep: 'me' });
  });

  test('is idempotent: a second run repairs nothing and changes nothing', async () => {
    await seed('two', [{ a: 1 }, patch(5)]);
    await v282.handler!(engine);
    const after = await frontmatterOf('two');
    expect(await repairEmbedSkipFrontmatter(engine)).toEqual({ repaired: 0, untouched: [] });
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
});
