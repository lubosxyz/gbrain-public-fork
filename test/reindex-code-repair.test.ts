import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
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
import { validateReindexModeScope } from '../src/commands/reindex.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';

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
});
