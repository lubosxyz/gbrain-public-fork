import { describe, test, expect, beforeAll, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realEmbedRetry from '../src/core/embed-retry.ts';

let mockEmbedBatchFn: ((texts: string[]) => Promise<Float32Array[]>) | null = null;
let embedBatchCalls: string[][] = [];

mock.module('../src/core/embed-retry.ts', () => ({
  ...realEmbedRetry,
  embedBatchWithBackoff: async (texts: string[], opts?: unknown) => {
    embedBatchCalls.push(texts);
    if (mockEmbedBatchFn) {
      return await mockEmbedBatchFn(texts);
    }
    return texts.map(() => new Float32Array(1536).fill(0.99));
  },
}));

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { validateReindexModeScope, dispatchReindex, normalizeReindexArgs } from '../src/commands/reindex.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';
import { reindexCodeProjection } from '../src/core/persistence/projection-reindex.ts';

describe('code metadata repair path', () => {
  let engine: PGLiteEngine;
  let tmpDir: string;
  let tsFile: string;
  const relPath = 'src/example.ts';

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-code-repair-'));
    tsFile = join(tmpDir, 'example.ts');
    writeFileSync(tsFile, 'export function computeAnswer(): number {\n  return 42;\n}\n');

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60000);

  afterAll(async () => {
    try {
      await engine.disconnect();
    } catch {}
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('BUG 1: importFromFile forwards forceRechunk/force to importCodeFile', async () => {
    // 1. Initial import
    const res1 = await importFromFile(engine, tsFile, relPath, { noEmbed: true });
    expect(res1.status).toBe('imported');

    // 2. Unchanged file without force should be skipped
    const res2 = await importFromFile(engine, tsFile, relPath, { noEmbed: true });
    expect(res2.status).toBe('skipped');

    // 3. Unchanged file WITH forceRechunk should be re-imported, NOT skipped
    const res3 = await importFromFile(engine, tsFile, relPath, { noEmbed: true, forceRechunk: true });
    expect(res3.status).toBe('imported');

    // 4. Unchanged file WITH force should also be re-imported
    const res4 = await importFromFile(engine, tsFile, relPath, { noEmbed: true, force: true });
    expect(res4.status).toBe('imported');
  });

  test('reindex --code flag is recognized as a valid target', async () => {
    // validateReindexModeScope allows --code
    expect(validateReindexModeScope(['--code'])).toBeNull();
    expect(validateReindexModeScope(['--code', '--type', 'page'])).toContain('--type is only supported with reindex --markdown');
    // reindex-code has no page cap or repo override: these must be refused, not silently ignored.
    for (const args of [['--code', '--limit', '5'], ['--code', '--limit=5'], ['--code', '--repo', '/tmp/x']]) {
      expect(validateReindexModeScope(args)).toContain('is not supported with reindex --code');
    }
    expect(validateReindexModeScope(['--markdown', '--limit', '5'])).toBeNull();
    // Only reindex-code honours a spend cap; every other mode must refuse it rather than run uncapped.
    for (const mode of ['--markdown', '--multimodal', '--aliases']) {
      expect(validateReindexModeScope([mode, '--max-cost', '5', '--yes'])).toContain('--max-cost is only supported with reindex --code');
      expect(validateReindexModeScope([mode, '--max-cost-usd=5'])).toContain('--max-cost-usd is only supported with reindex --code');
    }
    // With reindex-code's registry (what the CLI passes), --code accepts exactly reindex-code's flags.
    const codeFlags = CLI_FLAG_REGISTRY['reindex-code'];
    expect(validateReindexModeScope(['--code', '--source', 'x', '--workers', '2', '--force', '--no-embed', '--yes', '--json', '--max-cost', '5'], codeFlags)).toBeNull();
    expect(normalizeReindexArgs(['--code', '--max-cost=5', '--max-cost-usd=off'])).toEqual(['--code', '--max-cost', '5', '--max-cost-usd', 'off']);
    expect(validateReindexModeScope(['--code', '--max-cost=5'], codeFlags)).toBeNull();
    for (const [args, message] of [
      [['--code', '--dry-run=true', '--yes'], '--dry-run takes no value'],
      [['--code', '--cost-estimate', '--yes'], '--cost-estimate is not supported'],
      [['--code', '--force-rechunk'], '--force-rechunk is not supported'],
      [['--code', '--limit', '5'], '--limit is not supported'],
      [['--code', '--multimodal'], '--code cannot be combined with --multimodal'],
      [['--code', '--markdown'], '--code cannot be combined with --markdown'],
      // Registry bleed reindex-code never reads: a paid rebuild must not run with a different model.
      [['--code', '--embedding-model', 'other:model', '--force', '--yes'], '--embedding-model is not supported'],
      [['--code', '--status'], '--status is not supported'],
      // An empty or missing value would widen the run to every source.
      [['--code', '--source=', '--force', '--yes'], '--source requires a value'],
      [['--code', '--source', '--force'], '--source requires a value'],
      [['--code', '--max-cost'], '--max-cost requires a value'],
    ] as const) {
      expect(validateReindexModeScope([...args], codeFlags)).toContain(message);
    }

    // runReindexCode with --dry-run
    const result = await runReindexCode(engine, { dryRun: true });
    expect(result.status).toBe('dry_run');
  });

  test('BUG 2: force re-chunk preserves existing embeddings and restores wiped symbol metadata', async () => {
    const slug = 'src-example-ts';
    // Initial import with force
    await importFromFile(engine, tsFile, relPath, { noEmbed: true, force: true });

    // Set a synthetic embedding on the chunk and wipe its symbol metadata
    const dummyVector = new Float32Array(1536).fill(0.42);
    const existing = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(existing.length).toBeGreaterThan(0);

    // Upsert chunk with dummy embedding
    await engine.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: existing[0]!.chunk_text,
      chunk_source: 'fenced_code',
      embedding: dummyVector,
      token_count: 10,
    }]);

    // Force chunker_version to 1 and wipe symbol_name_qualified to simulate legacy wiped state
    await engine.executeRaw('UPDATE pages SET chunker_version = 1 WHERE slug = $1', [slug]);
    await engine.executeRaw('UPDATE content_chunks SET symbol_name_qualified = NULL, symbol_name = NULL WHERE chunk_index = 0');

    // Verify wiped state using scoped read API
    const wipedChunks = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(wipedChunks[0]!.symbol_name_qualified).toBeNull();
    expect(wipedChunks[0]!.embedding).not.toBeNull();

    // Now re-import with forceRechunk: true WITHOUT noEmbed (normal embed flow)
    // If embedding reuse works, it should reuse dummyVector and NOT call external embed API
    embedBatchCalls = [];
    const res = await importFromFile(engine, tsFile, relPath, { forceRechunk: true });
    expect(res.status).toBe('imported');
    expect(embedBatchCalls.length).toBe(0);

    // Verify restored symbol metadata AND preserved embedding
    const restoredChunks = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(restoredChunks.length).toBeGreaterThan(0);
    expect(restoredChunks[0]!.symbol_name_qualified).toBe('computeAnswer');
    expect(restoredChunks[0]!.embedding).not.toBeNull();
    expect(restoredChunks[0]!.embedding![0]).toBeCloseTo(0.42);
  });

  test('changed chunk gets a fresh embedding while unchanged chunk reuses existing embedding', async () => {
    const multiRelPath = 'src/multi.ts';
    const multiFile = join(tmpDir, 'multi.ts');
    const slug = 'src-multi-ts';

    // 1. Write file with two distinct functions
    writeFileSync(
      multiFile,
      'export function alpha(): number {\n  return 100;\n}\n\nexport function beta(): number {\n  return 200;\n}\n',
    );

    await importFromFile(engine, multiFile, multiRelPath, { noEmbed: true, force: true });

    const existing = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(existing.length).toBe(2);

    const alphaVector = new Float32Array(1536).fill(0.11);
    const betaVector = new Float32Array(1536).fill(0.22);

    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: existing[0]!.chunk_text,
        chunk_source: 'fenced_code',
        embedding: alphaVector,
        token_count: 10,
        symbol_name_qualified: 'alpha',
      },
      {
        chunk_index: 1,
        chunk_text: existing[1]!.chunk_text,
        chunk_source: 'fenced_code',
        embedding: betaVector,
        token_count: 10,
        symbol_name_qualified: 'beta',
      },
    ]);

    // 2. Modify multiFile: alpha is unchanged, beta body changes
    writeFileSync(
      multiFile,
      'export function alpha(): number {\n  return 100;\n}\n\nexport function beta(): number {\n  return 99999;\n}\n',
    );

    embedBatchCalls = [];
    mockEmbedBatchFn = async (texts: string[]) => {
      return texts.map(() => new Float32Array(1536).fill(0.77));
    };

    const res = await importFromFile(engine, multiFile, multiRelPath, { forceRechunk: true });
    expect(res.status).toBe('imported');

    // Only beta needed embedding
    expect(embedBatchCalls.length).toBe(1);
    expect(embedBatchCalls[0]!.length).toBe(1);
    expect(embedBatchCalls[0]![0]).toContain('99999');

    // Verify stored chunks
    const updatedChunks = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(updatedChunks.length).toBe(2);

    const alphaChunk = updatedChunks.find((c) => c.symbol_name_qualified === 'alpha');
    const betaChunk = updatedChunks.find((c) => c.symbol_name_qualified === 'beta');

    expect(alphaChunk).toBeDefined();
    expect(betaChunk).toBeDefined();

    // alpha chunk kept its existing embedding
    expect(alphaChunk!.embedding).not.toBeNull();
    expect(alphaChunk!.embedding![0]).toBeCloseTo(0.11);

    // beta chunk received a freshly generated embedding, not the old 0.22
    expect(betaChunk!.embedding).not.toBeNull();
    expect(betaChunk!.embedding![0]).toBeCloseTo(0.77);
  });

  test('--force with --no-embed preserves matching chunk embeddings instead of wiping them', async () => {
    const slug = 'src-example-ts';
    // Ensure example.ts is imported and has an embedding
    const existing = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(existing.length).toBeGreaterThan(0);
    expect(existing[0]!.embedding).not.toBeNull();
    expect(existing[0]!.embedding![0]).toBeCloseTo(0.42);

    // Re-import with force: true and noEmbed: true
    const res = await importFromFile(engine, tsFile, relPath, { force: true, noEmbed: true });
    expect(res.status).toBe('imported');

    // The embedding must NOT be wiped to null
    const afterChunks = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(afterChunks.length).toBeGreaterThan(0);
    expect(afterChunks[0]!.embedding).not.toBeNull();
    expect(afterChunks[0]!.embedding![0]).toBeCloseTo(0.42);
  });

  test('reindex --code --force restores wiped metadata without any embedding call', async () => {
    const repairRel = 'src/repair.ts';
    const repairFile = join(tmpDir, 'repair.ts');
    const slug = 'src-repair-ts';
    writeFileSync(repairFile, 'export function gamma(): number {\n  return 7;\n}\n\nexport function delta(): number {\n  return 8;\n}\n');
    embedBatchCalls = [];
    mockEmbedBatchFn = async (texts: string[]) => texts.map(() => new Float32Array(1536).fill(0.33));
    await importFromFile(engine, repairFile, repairRel, {});
    expect(embedBatchCalls.length).toBe(1);
    const embedded = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    expect(embedded.length).toBe(2);
    expect(embedded.every((c) => c.embedding && c.model)).toBe(true);

    // Simulate the metadata-blind writer: same text and vectors, symbol columns gone.
    await engine.executeRaw(`UPDATE content_chunks SET symbol_name = NULL, symbol_type = NULL, language = NULL,
      symbol_name_qualified = NULL, parent_symbol_path = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`, [slug]);

    for (const noEmbed of [false, true]) {
      embedBatchCalls = [];
      const res = await reindexCodeProjection(engine, slug, 'default', { force: true, noEmbed });
      expect(res.status).toBe('imported');
      expect(embedBatchCalls.length).toBe(0);
      const repaired = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
      expect(repaired.map((c) => c.symbol_name_qualified).sort()).toEqual(['delta', 'gamma']);
      for (const chunk of repaired) {
        expect(chunk.embedding).not.toBeNull();
        expect(chunk.embedding![0]).toBeCloseTo(0.33);
      }
      await engine.executeRaw(`UPDATE content_chunks SET symbol_name = NULL, symbol_name_qualified = NULL, language = NULL
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`, [slug]);
    }
  });
  test('reindex --code --force never reuses a vector whose text hash is stale', async () => {
    const staleRel = 'src/stale.ts';
    const staleFile = join(tmpDir, 'stale.ts');
    const slug = 'src-stale-ts';
    writeFileSync(staleFile, 'export function epsilon(): number {\n  return 5;\n}\n');
    mockEmbedBatchFn = async (texts: string[]) => texts.map(() => new Float32Array(1536).fill(0.11));
    await importFromFile(engine, staleFile, staleRel, {});
    const pageId = `(SELECT id FROM pages WHERE slug = $1)`;
    // Embed mode first: both passes then start from a stored vector (0.11, later 0.55) marked stale.
    for (const noEmbed of [false, true]) {
      expect((await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true })).every((c) => c.embedding !== null)).toBe(true);
      await engine.executeRaw(`UPDATE content_chunks SET symbol_name_qualified = NULL, embedded_text_hash = 'stale' WHERE page_id = ${pageId}`, [slug]);
      embedBatchCalls = [];
      mockEmbedBatchFn = async (texts: string[]) => texts.map(() => new Float32Array(1536).fill(0.55));
      expect((await reindexCodeProjection(engine, slug, 'default', { force: true, noEmbed })).status).toBe('imported');
      const repaired = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
      expect(repaired.map((c) => c.symbol_name_qualified)).toEqual(['epsilon']);
      if (noEmbed) {
        expect(embedBatchCalls.length).toBe(0);
        expect(repaired.every((c) => c.embedding === null)).toBe(true);
      } else {
        expect(embedBatchCalls.length).toBe(1);
        expect(repaired.every((c) => c.embedding !== null && Math.abs(c.embedding[0]! - 0.55) < 1e-6)).toBe(true);
      }
    }
  });
  // Value: protects=a code edit re-embeds only the changed chunk and the untouched neighbour keeps its vector at its own index; fails_when=importCodeFile stops reading stored vectors or maps a reused vector onto the wrong chunk; why_new=existing repair tests only cover fully unchanged files; seam=none
  test('editing one function re-embeds only that chunk and keeps the unchanged neighbour vector', async () => {
    const partialFile = join(tmpDir, 'partial.ts');
    const slug = 'src-partial-ts';
    writeFileSync(partialFile, 'export function iota(): number {\n  return 1;\n}\n\nexport function kappa(): number {\n  return 2;\n}\n');
    mockEmbedBatchFn = async (texts: string[]) => texts.map(() => new Float32Array(1536).fill(0.21));
    await importFromFile(engine, partialFile, 'src/partial.ts', {});
    writeFileSync(partialFile, 'export function iota(): number {\n  return 1;\n}\n\nexport function kappa(): number {\n  return 3;\n}\n');
    embedBatchCalls = [];
    mockEmbedBatchFn = async (texts: string[]) => texts.map(() => new Float32Array(1536).fill(0.77));
    expect((await importFromFile(engine, partialFile, 'src/partial.ts', {})).status).toBe('imported');
    expect(embedBatchCalls.flat().length).toBe(1);
    expect(embedBatchCalls.flat()[0]).toContain('return 3');
    const chunks = await engine.getChunks(slug, { includeEmbedding: true, includeUnsealed: true });
    const vectorOf = (name: string) => chunks.find((c) => c.symbol_name_qualified === name)!.embedding![0];
    expect(vectorOf('iota')).toBeCloseTo(0.21);
    expect(vectorOf('kappa')).toBeCloseTo(0.77);
  });
  // Value: protects=`gbrain reindex --code` reaches the code reindexer while `--markdown` stays on the markdown reindexer; fails_when=dispatchReindex routes --code to runReindex (which demands --markdown) or sends markdown args to runReindexCodeCli; why_new=the dispatch moved out of cli.ts's untestable switch and no test exercised it; seam=none
  test('dispatchReindex routes --code to the code reindexer and --markdown to the markdown reindexer', async () => {
    const dispatchFile = join(tmpDir, 'dispatch.ts');
    writeFileSync(dispatchFile, 'export function zeta(): number {\n  return 6;\n}\n');
    await importFromFile(engine, dispatchFile, 'src/dispatch.ts', { noEmbed: true });
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write);
    try {
      await dispatchReindex(engine, ['--code', '--dry-run', '--json']);
      const code = JSON.parse(lines.join('\n'));
      expect(code.status).toBe('dry_run');
      expect(code.codePages).toBeGreaterThan(0);
      lines.length = 0;
      await dispatchReindex(engine, ['--markdown', '--dry-run', '--json']);
      const markdown = JSON.parse(lines.join('\n'));
      expect(markdown.chunker_version).toBeDefined();
      expect(markdown.codePages).toBeUndefined();
    } finally { log.mockRestore(); write.mockRestore(); }
  });
});
