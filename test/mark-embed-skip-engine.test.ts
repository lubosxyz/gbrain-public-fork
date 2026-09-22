/**
 * parked-chunk accounting — `engine.markEmbedSkip` against a real engine.
 *
 * The embed path calls this to park a page holding a chunk the embedder
 * rejected as over-context. It is a jsonb MERGE, which is the part worth
 * pinning: the naive `SET frontmatter = $1` would wipe every other key, and
 * the double-encoding trap this repo has been bitten by before (a jsonb
 * STRING `||` a jsonb OBJECT yields an ARRAY, silently emptying the
 * frontmatter) is invisible until something reads the page back.
 *
 * Runs against PGLite, which is real PostgreSQL — the same jsonb semantics
 * the Postgres engine relies on. The Postgres half of the pair is exercised
 * end-to-end by `gbrain embed --stale` in the parked-chunk accounting verification.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { EMBED_SKIP_KEY, buildChunkTokenLimitMarker, isEmbedSkipped } from '../src/core/embed-skip.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
});

async function seedPage(slug: string, frontmatter: Record<string, unknown> | null): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: 'body',
    timeline: '',
    frontmatter: frontmatter ?? {},
  } as any);
}

async function readFrontmatter(slug: string): Promise<Record<string, unknown> | null> {
  const page = await engine.getPage(slug);
  return (page?.frontmatter as Record<string, unknown> | undefined) ?? null;
}

describe('markEmbedSkip', () => {
  test('writes a marker the shared predicate recognizes', async () => {
    await seedPage('parked-page', {});
    await engine.markEmbedSkip('parked-page', { marker: buildChunkTokenLimitMarker(6057) });

    const fm = await readFrontmatter('parked-page');
    expect(isEmbedSkipped(fm)).toBe(true);
    const marker = fm![EMBED_SKIP_KEY] as Record<string, unknown>;
    expect(marker.reason).toBe('chunk_token_limit');
    expect(marker.bytes).toBe(6057);
    expect(typeof marker.assessed_at).toBe('string');
  });

  test('merges — the rest of the frontmatter survives', async () => {
    // The failure mode this exists to prevent: parking a page silently
    // stripping its tags, ids and content flags.
    await seedPage('rich-page', { id: 'ext-42', domain: 'ops', content_flag: { reason: 'markup_heavy' } });
    await engine.markEmbedSkip('rich-page', { marker: buildChunkTokenLimitMarker(9477) });

    const fm = await readFrontmatter('rich-page');
    expect(fm!.id).toBe('ext-42');
    expect(fm!.domain).toBe('ops');
    expect(fm!.content_flag).toEqual({ reason: 'markup_heavy' } as any);
    expect(isEmbedSkipped(fm)).toBe(true);
  });

  test('the marker lands as a jsonb OBJECT, not a double-encoded string', async () => {
    // Direct type assertion: a double-encoded patch would make `||`
    // concatenate into an array and take the whole frontmatter with it.
    await seedPage('typed-page', { keep: 'me' });
    await engine.markEmbedSkip('typed-page', { marker: buildChunkTokenLimitMarker(1) });

    const rows = await engine.executeRaw(
      `SELECT jsonb_typeof(frontmatter) AS fm_type,
              jsonb_typeof(frontmatter -> '${EMBED_SKIP_KEY}') AS marker_type
         FROM pages WHERE slug = 'typed-page'`,
    );
    expect((rows as any[])[0].fm_type).toBe('object');
    expect((rows as any[])[0].marker_type).toBe('object');
  });

  test('is idempotent and re-assessment overwrites the previous marker', async () => {
    await seedPage('reassessed-page', {});
    await engine.markEmbedSkip('reassessed-page', { marker: buildChunkTokenLimitMarker(100) });
    await engine.markEmbedSkip('reassessed-page', { marker: buildChunkTokenLimitMarker(200) });

    const marker = (await readFrontmatter('reassessed-page'))![EMBED_SKIP_KEY] as Record<string, unknown>;
    expect(marker.bytes).toBe(200);
  });

  test('a page with empty frontmatter is still markable', async () => {
    // `pages.frontmatter` is `JSONB NOT NULL DEFAULT '{}'` (src/schema.sql),
    // so an empty object — not NULL — is the real floor case. The COALESCE in
    // both engines' merge is belt-and-braces against a schema that predates
    // that constraint; this pins the case that can actually occur.
    await seedPage('bare-page', {});
    await engine.markEmbedSkip('bare-page', { marker: buildChunkTokenLimitMarker(7) });

    const fm = await readFrontmatter('bare-page');
    expect(isEmbedSkipped(fm)).toBe(true);
    expect(Object.keys(fm!)).toEqual([EMBED_SKIP_KEY]);
  });

  test('a missing page is a no-op, not a throw', async () => {
    // The embed path calls this after the fact; a page deleted mid-run must
    // not turn a settled verdict into a crash.
    await expect(
      engine.markEmbedSkip('never-existed', { marker: buildChunkTokenLimitMarker(1) }),
    ).resolves.toBeUndefined();
  });

  test('a parked page drops out of stale-chunk selection', async () => {
    // The whole point of parking: the shared embed-skip filter already backs
    // both engines' listStaleChunks, so writing the marker is what actually
    // stops the unbounded retry.
    await seedPage('stale-page', {});
    await engine.upsertChunks('stale-page', [
      { chunk_index: 0, chunk_text: 'unembedded', chunk_source: 'compiled_truth' },
    ] as any);
    expect(await engine.countStaleChunks()).toBe(1);

    await engine.markEmbedSkip('stale-page', { marker: buildChunkTokenLimitMarker(10) });

    expect(await engine.countStaleChunks()).toBe(0);
    expect(await engine.listStaleChunks({ batchSize: 10 })).toHaveLength(0);
  });
});
