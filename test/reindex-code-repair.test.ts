import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { runReindex, validateReindexModeScope } from '../src/commands/reindex.ts';

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

    // runReindex with --code and --dry-run runs without target flag error
    const result = await runReindex(engine, ['--code', '--dry-run', '--json']);
    expect(result.dryRun).toBe(true);
  });

  test('BUG 2: force re-chunk preserves existing embeddings and restores wiped symbol metadata', async () => {
    const slug = 'src-example-ts';
    // Initial import with force
    await importFromFile(engine, tsFile, relPath, { noEmbed: true, force: true });

    // Set a synthetic embedding on the chunk and wipe its symbol metadata
    const dummyVector = new Float32Array(1536).fill(0.42);
    const existing = await engine.getChunks(slug, { includeEmbedding: true });
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

    // Verify wiped state
    const wipedChunks = await engine.getChunksWithEmbeddings(slug);
    expect(wipedChunks[0]!.symbol_name_qualified).toBeNull();
    expect(wipedChunks[0]!.embedding).not.toBeNull();

    // Now re-import with forceRechunk: true WITHOUT noEmbed (normal embed flow)
    // If embedding reuse works, it should reuse dummyVector and NOT call external embed API
    const res = await importFromFile(engine, tsFile, relPath, { forceRechunk: true });
    expect(res.status).toBe('imported');

    // Verify restored symbol metadata AND preserved embedding
    const restoredChunks = await engine.getChunks(slug, { includeEmbedding: true });
    expect(restoredChunks.length).toBeGreaterThan(0);
    expect(restoredChunks[0]!.symbol_name_qualified).toBe('computeAnswer');
    expect(restoredChunks[0]!.embedding).not.toBeNull();
    expect(restoredChunks[0]!.embedding![0]).toBeCloseTo(0.42);
  });
});
