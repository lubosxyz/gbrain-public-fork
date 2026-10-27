/**
 * Shared cases for scripts/repair-embed-skip-frontmatter.ts, run once against
 * PGLite (test/repair-embed-skip-frontmatter.test.ts) and once against a real
 * Postgres (test/e2e/embed-skip-jsonb-postgres.test.ts). The caller supplies how
 * damaged rows get seeded: on Postgres through the exact legacy statement, so the
 * array shape under test is the one production actually produced.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { repairEmbedSkipFrontmatter, renderReport } from '../../scripts/repair-embed-skip-frontmatter.ts';
import { buildChunkTokenLimitMarker } from '../../src/core/embed-skip.ts';

export interface RepairCaseHooks {
  engine(): BrainEngine;
  reset(): Promise<void>;
  /** Insert a page whose frontmatter is the damaged `[original, "<marker json>", ...]` array. */
  seedDamaged(slug: string, original: Record<string, unknown>, markerBytes: number[]): Promise<void>;
  /** Insert a page whose frontmatter is exactly this (arbitrary) JSON value. */
  seedRaw(slug: string, value: unknown): Promise<void>;
}

async function readFm(engine: BrainEngine, slug: string): Promise<{ type: string; value: any }> {
  const rows = await engine.executeRaw<{ t: string; fm: unknown }>(
    `SELECT jsonb_typeof(frontmatter) AS t, frontmatter AS fm FROM pages WHERE slug = $1`,
    [slug],
  );
  const fm = typeof rows[0].fm === 'string' ? JSON.parse(rows[0].fm) : rows[0].fm;
  return { type: rows[0].t, value: fm };
}

export function defineRepairCases(h: RepairCaseHooks): void {
  describe('repair-embed-skip-frontmatter', () => {
    beforeEach(async () => { await h.reset(); });

    test('dry run reports the damaged rows and changes nothing', async () => {
      await h.seedDamaged('damaged/one', { keep: 'me' }, [100]);
      const before = await readFm(h.engine(), 'damaged/one');
      expect(before.type).toBe('array');

      const report = await repairEmbedSkipFrontmatter(h.engine(), { apply: false });
      expect(report.mode).toBe('dry-run');
      expect(report.repairable.map(r => r.slug)).toEqual(['damaged/one']);
      expect(report.repaired).toBe(0);
      expect(renderReport(report)).toContain('damaged/one');
      expect(await readFm(h.engine(), 'damaged/one')).toEqual(before);
    });

    test('apply turns a 2-element array into an object with every original key and the marker', async () => {
      await h.seedDamaged('damaged/two', { id: 'ext-1', tags: ['a', 'b'], nested: { k: 1 } }, [4242]);
      const report = await repairEmbedSkipFrontmatter(h.engine(), { apply: true });
      expect(report.repaired).toBe(1);

      const fm = await readFm(h.engine(), 'damaged/two');
      expect(fm.type).toBe('object');
      expect(fm.value.id).toBe('ext-1');
      expect(fm.value.tags).toEqual(['a', 'b']);
      expect(fm.value.nested).toEqual({ k: 1 });
      expect(fm.value.embed_skip.reason).toBe('chunk_token_limit');
      expect(fm.value.embed_skip.bytes).toBe(4242);
    });

    test('a many-element array (repeated retries) keeps the newest marker', async () => {
      await h.seedDamaged('damaged/many', { keep: 'me' }, [10, 20, 30, 40, 50]);
      const report = await repairEmbedSkipFrontmatter(h.engine(), { apply: true });
      expect(report.repaired).toBe(1);

      const fm = await readFm(h.engine(), 'damaged/many');
      expect(fm.type).toBe('object');
      expect(fm.value.keep).toBe('me');
      expect(fm.value.embed_skip.bytes).toBe(50);
      expect(Object.keys(fm.value).sort()).toEqual(['embed_skip', 'keep']);
    });

    test('foreign arrays are reported and left exactly as they were', async () => {
      const foreign: Record<string, unknown> = {
        'foreign/numbers': [1, 2, 3],
        'foreign/single': [{ a: 1 }],
        'foreign/not-json': [{ a: 1 }, 'not json'],
        'foreign/other-key': [{ a: 1 }, JSON.stringify({ other: 1 })],
        'foreign/extra-key': [{ a: 1 }, JSON.stringify({ embed_skip: { bytes: 1 }, more: 2 })],
        'foreign/non-object-head': ['x', JSON.stringify({ embed_skip: { bytes: 1 } })],
        'foreign/nested-array-tail': [{ a: 1 }, [JSON.stringify({ embed_skip: { bytes: 1 } })]],
        // Payloads that carry the key but are not what markEmbedSkip writes.
        'foreign/marker-null': [{ keep: 'original' }, JSON.stringify({ embed_skip: null })],
        'foreign/marker-number': [{ a: 1 }, JSON.stringify({ embed_skip: 7 })],
        'foreign/marker-string': [{ a: 1 }, JSON.stringify({ embed_skip: 'x' })],
        'foreign/marker-array': [{ a: 1 }, JSON.stringify({ embed_skip: [1, 2] })],
        'foreign/marker-unrelated-keys': [{ a: 1 }, JSON.stringify({ embed_skip: { unrelated: 1 } })],
        'foreign/marker-extra-inner-key': [{ a: 1 }, JSON.stringify({ embed_skip: { ...buildChunkTokenLimitMarker(3), extra: true } })],
        'foreign/marker-bytes-string': [{ a: 1 }, JSON.stringify({ embed_skip: { ...buildChunkTokenLimitMarker(3), bytes: '3' } })],
        'foreign/marker-negative-bytes': [{ a: 1 }, JSON.stringify({ embed_skip: { ...buildChunkTokenLimitMarker(3), bytes: -3 } })],
        'foreign/marker-unknown-reason': [{ a: 1 }, JSON.stringify({ embed_skip: { ...buildChunkTokenLimitMarker(3), reason: 'other' } })],
        'foreign/marker-bad-timestamp': [{ a: 1 }, JSON.stringify({ embed_skip: { ...buildChunkTokenLimitMarker(3), assessed_at: 'not a date' } })],
        'foreign/second-element-valid-third-not': [{ a: 1 }, JSON.stringify({ embed_skip: buildChunkTokenLimitMarker(3) }), JSON.stringify({ embed_skip: null })],
        'foreign/top-level-array-payload': [{ a: 1 }, JSON.stringify([{ embed_skip: buildChunkTokenLimitMarker(3) }])],
        'foreign/top-level-null-payload': [{ a: 1 }, 'null'],
      };
      for (const [slug, value] of Object.entries(foreign)) await h.seedRaw(slug, value);
      await h.seedDamaged('damaged/among-foreign', { keep: 'me' }, [7]);

      const report = await repairEmbedSkipFrontmatter(h.engine(), { apply: true });
      expect(report.repaired).toBe(1);
      expect(report.repairable.map(r => r.slug)).toEqual(['damaged/among-foreign']);
      expect(report.foreign.map(r => r.slug).sort()).toEqual(Object.keys(foreign).sort());

      for (const [slug, value] of Object.entries(foreign)) {
        const fm = await readFm(h.engine(), slug);
        expect(fm.type).toBe('array');
        expect(fm.value).toEqual(value);
      }
      expect((await readFm(h.engine(), 'damaged/among-foreign')).type).toBe('object');
    });

    test('object frontmatter is never touched', async () => {
      await h.seedRaw('healthy/page', { keep: 'me', embed_skip: buildChunkTokenLimitMarker(5) });
      const before = await readFm(h.engine(), 'healthy/page');
      const report = await repairEmbedSkipFrontmatter(h.engine(), { apply: true });
      expect(report.repairable).toHaveLength(0);
      expect(report.foreign).toHaveLength(0);
      expect(await readFm(h.engine(), 'healthy/page')).toEqual(before);
    });

    test('re-running after a repair is a no-op', async () => {
      await h.seedDamaged('damaged/rerun', { keep: 'me' }, [1, 2]);
      const first = await repairEmbedSkipFrontmatter(h.engine(), { apply: true });
      expect(first.repaired).toBe(1);
      const afterFirst = await readFm(h.engine(), 'damaged/rerun');

      const second = await repairEmbedSkipFrontmatter(h.engine(), { apply: true });
      expect(second.repairable).toHaveLength(0);
      expect(second.repaired).toBe(0);
      expect(await readFm(h.engine(), 'damaged/rerun')).toEqual(afterFirst);
    });
  });
}
