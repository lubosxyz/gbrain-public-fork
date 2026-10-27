/**
 * scripts/repair-embed-skip-frontmatter.ts against PGLite. The Postgres half
 * (rows produced by the real legacy double-encode) is
 * test/e2e/embed-skip-jsonb-postgres.test.ts; both run the same cases.
 */
import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { EMBED_SKIP_KEY, buildChunkTokenLimitMarker } from '../src/core/embed-skip.ts';
import { defineRepairCases } from './helpers/embed-skip-repair-cases.ts';
import { repairEmbedSkipFrontmatter } from '../scripts/repair-embed-skip-frontmatter.ts';

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

describe('repair-embed-skip-frontmatter on a brain that guards canonical writes', () => {
  test('--apply is refused by the database guard and changes nothing', async () => {
    await engine.executeRaw('DELETE FROM pages');
    const damaged = JSON.stringify([{ keep: 'me' }, JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(9) })]);
    await insertPage('managed/damaged', damaged);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      await expect(repairEmbedSkipFrontmatter(engine, { apply: true })).rejects.toThrow('writer_coordinator_required');
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
    const rows = await engine.executeRaw<{ t: string }>(`SELECT jsonb_typeof(frontmatter) AS t FROM pages WHERE slug = 'managed/damaged'`);
    expect(rows[0].t).toBe('array');
  });
});
