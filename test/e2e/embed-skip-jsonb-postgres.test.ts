/**
 * markEmbedSkip on a REAL Postgres (postgres.js), plus the repair script for the
 * rows the pre-0.60.183 write damaged.
 *
 * The regression: `COALESCE(frontmatter,'{}') || ${JSON.stringify(patch)}::jsonb`
 * double-encodes on postgres.js (the string becomes a jsonb string scalar), and
 * `object || string` yields an ARRAY `[<frontmatter>, "<marker json>"]`. PGLite
 * parses the cast natively and hides it, so the unit test passes while every
 * Postgres brain corrupts the page. This file fails on the 0.60.182.0 write.
 *
 * Run: DATABASE_URL=postgresql://.../gbrain_test bun test test/e2e/embed-skip-jsonb-postgres.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { EMBED_SKIP_KEY, buildChunkTokenLimitMarker, isEmbedSkipped } from '../../src/core/embed-skip.ts';
import { defineRepairCases } from '../helpers/embed-skip-repair-cases.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) console.log('Skipping embed-skip Postgres e2e (DATABASE_URL not set)');

async function seedPage(slug: string, frontmatter: Record<string, unknown>): Promise<void> {
  await getEngine().putPage(slug, {
    type: 'note', title: slug, compiled_truth: 'body', timeline: '', frontmatter,
  } as any);
}

async function readShape(slug: string) {
  const rows = await getConn().unsafe(
    `SELECT jsonb_typeof(frontmatter) AS t,
            frontmatter AS fm,
            frontmatter->'${EMBED_SKIP_KEY}'->>'bytes' AS bytes
       FROM pages WHERE slug = $1`,
    [slug],
  );
  return rows[0] as unknown as { t: string; fm: any; bytes: string | null };
}

describeE2E('embed-skip jsonb on Postgres', () => {
  beforeAll(async () => { await setupDB(); }, 180_000);
  afterAll(async () => { await teardownDB(); });

  describe('markEmbedSkip keeps frontmatter an object', () => {
    beforeEach(async () => { await getConn().unsafe('DELETE FROM pages'); });

    test('a page with existing frontmatter keeps every key and gains a readable marker', async () => {
      await seedPage('park/rich', { id: 'ext-42', domain: 'ops', tags: ['a', 'b'], nested: { k: 1 } });
      await getEngine().markEmbedSkip('park/rich', { marker: buildChunkTokenLimitMarker(6057) });

      const row = await readShape('park/rich');
      expect(row.t).toBe('object');
      expect(row.fm.id).toBe('ext-42');
      expect(row.fm.domain).toBe('ops');
      expect(row.fm.tags).toEqual(['a', 'b']);
      expect(row.fm.nested).toEqual({ k: 1 });
      expect(row.bytes).toBe('6057');
      expect(isEmbedSkipped(row.fm)).toBe(true);
    }, 30_000);

    test('repeated parking overwrites the marker and never grows an array', async () => {
      await seedPage('park/retry', { keep: 'me' });
      for (const bytes of [100, 200, 300]) {
        await getEngine().markEmbedSkip('park/retry', { marker: buildChunkTokenLimitMarker(bytes) });
      }
      const row = await readShape('park/retry');
      expect(row.t).toBe('object');
      expect(row.fm.keep).toBe('me');
      expect(row.bytes).toBe('300');
      expect(Object.keys(row.fm).sort()).toEqual([EMBED_SKIP_KEY, 'keep']);
    }, 30_000);

    test('only the targeted source/slug is touched', async () => {
      await seedPage('park/target', { a: 1 });
      await seedPage('park/bystander', { b: 2 });
      await getEngine().markEmbedSkip('park/target', { marker: buildChunkTokenLimitMarker(1) });
      const bystander = await readShape('park/bystander');
      expect(bystander.t).toBe('object');
      expect(bystander.fm).toEqual({ b: 2 });
    }, 30_000);
  });

  describe('repair script (rows produced by the legacy write)', () => {
    async function insertPage(slug: string, frontmatterJson: string): Promise<void> {
      await getConn().unsafe(
        `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter)
         VALUES ($1, 'note', $1, 'body', '', $2::text::jsonb)`,
        [slug, frontmatterJson],
      );
    }

    defineRepairCases({
      engine: () => getEngine(),
      reset: async () => { await getConn().unsafe('DELETE FROM pages'); },
      // The exact statement shipped in 0.60.182.0: postgres.js binds the string as a
      // jsonb string scalar, so `object || scalar` produces the damaged array.
      seedDamaged: async (slug, original, markerBytes) => {
        await insertPage(slug, JSON.stringify(original));
        for (const bytes of markerBytes) {
          await getConn().unsafe(
            `UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || $1::jsonb WHERE slug = $2`,
            [JSON.stringify({ [EMBED_SKIP_KEY]: buildChunkTokenLimitMarker(bytes) }), slug],
          );
        }
        const shape = await readShape(slug);
        if (shape.t !== 'array') throw new Error(`legacy write did not reproduce the array shape (got ${shape.t})`);
      },
      seedRaw: async (slug, value) => { await insertPage(slug, JSON.stringify(value)); },
    });
  });
});
