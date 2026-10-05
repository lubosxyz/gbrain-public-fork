import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { runReindexCode } from '../src/commands/reindex-code.ts';
import { reindexCodeProjection } from '../src/core/persistence/projection-reindex.ts';
import { readProjectionSnapshot, preparePageProjection, installPageProjection, rebuildPendingPageProjections, queuePageProjection } from '../src/core/page-state/projections.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-code-recovery-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'code-recovery-example';
const body = 'export function beta() { return 3; }\nexport function alpha() { return beta(); }\n';

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false'); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function unseal(engine: BrainEngine, slug: string) {
  await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  await queuePageProjection(engine, sourceId, slug, 'test_recovery');
}
async function seed(engine: BrainEngine, name: string) {
  return (await importCodeFile(engine, `${name}.ts`, body, { sourceId, noEmbed: true })).slug;
}

test('code and Markdown jobs both recover keylessly without changing canonical identity or code metadata', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'queued');
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const original = await engine.getChunks(slug, { sourceId });
    await unseal(engine, slug);
    await engine.putPage('queued-note', { type: 'note', title: 'Example note', compiled_truth: 'Example fenced function.\n```ts\nexport function fencedExample() { return 7; }\n```' }, { sourceId });
    expect(await engine.getChunks(slug, { sourceId })).toEqual([]);
    expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBe(2);
    const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(after.revision).toBe(before.revision);
    expect(after.page.id).toBe(before.page.id);
    expect(after.page.content_hash).toBe(before.page.content_hash);
    expect(after.page.compiled_truth).toBe(body);
    expect(after.page.text_projection_revision).toBe(after.revision);
    expect((await engine.getChunks(slug, { sourceId })).map(c => [c.id, c.symbol_name, c.parent_symbol_path])).toEqual(original.map(c => [c.id, c.symbol_name, c.parent_symbol_path]));
    expect((await engine.getChunks('queued-note', { sourceId })).some(c => c.chunk_source === 'fenced_code' && c.symbol_name === 'fencedExample')).toBe(true);
    expect(await engine.getChunks(slug, { sourceId: 'default' })).toEqual([]);
  }
});

test('recovery keeps exact valid vectors and rejects model, hash, metadata and source provenance drift', async () => {
  for (const engine of engines) {
    for (const mismatch of ['none', 'model', 'hash', 'metadata', 'source']) {
      const slug = await seed(engine, `vector-${mismatch}`);
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      const vector = `[${Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0).join(',')}]`;
      await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1',
        [prepared.snapshot.page.id, vector, prepared.embeddingModel]);
      if (mismatch === 'model') await engine.executeRaw("UPDATE content_chunks SET model='example:other' WHERE page_id=$1", [prepared.snapshot.page.id]);
      if (mismatch === 'hash') await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash='bad' WHERE page_id=$1", [prepared.snapshot.page.id]);
      if (mismatch === 'metadata') await engine.executeRaw("UPDATE content_chunks SET language='python' WHERE page_id=$1", [prepared.snapshot.page.id]);
      if (mismatch === 'source') await engine.executeRaw("UPDATE content_chunks SET chunk_source='timeline' WHERE page_id=$1", [prepared.snapshot.page.id]);
      const old = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
      await unseal(engine, slug);
      expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBe(1);
      const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
      expect(chunks.every(c => c.embedding_is_null)).toBe(mismatch !== 'none');
      if (mismatch === 'none') expect(chunks.map(c => [c.id, c.embedding, c.embedded_at])).toEqual(old.map(c => [c.id, c.embedding, c.embedded_at]));
      else expect((await engine.countStaleChunks({ sourceId }))).toBeGreaterThan(0);
    }
  }
});

test('unchanged code import heals an unsealed page without canonical mutation', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'unchanged');
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    await unseal(engine, slug);
    expect(await importCodeFile(engine, 'unchanged.ts', body, { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
  }
});

test('a registry column retains only its own valid vectors and a column switch never copies legacy vectors', async () => {
  for (const engine of engines) {
    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_recovery vector(1536)');
    const priorColumn = await engine.getConfig('search_embedding_column');
    const priorRegistry = await engine.getConfig('embedding_columns');
    try {
      const slug = await seed(engine, 'column');
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      const vector = `[${Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0).join(',')}]`;
      await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1', [prepared.snapshot.page.id, vector, prepared.embeddingModel]);
      await engine.setConfig('embedding_columns', JSON.stringify({ embedding_recovery: { provider: prepared.embeddingModel, dimensions: 1536, type: 'vector' } }));
      await engine.setConfig('search_embedding_column', 'embedding_recovery');
      await unseal(engine, slug);
      await rebuildPendingPageProjections(engine, 100);
      expect((await engine.getChunks(slug, { sourceId })).every(c => c.embedding_is_null)).toBe(true);
      await engine.executeRaw('UPDATE content_chunks SET embedding_recovery=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1', [prepared.snapshot.page.id, vector, prepared.embeddingModel]);
      const before = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
      await unseal(engine, slug);
      await rebuildPendingPageProjections(engine, 100);
      expect((await engine.getChunks(slug, { sourceId, includeEmbedding: true })).map(c => [c.id, c.embedding])).toEqual(before.map(c => [c.id, c.embedding]));
    } finally {
      if (priorColumn === null) await engine.unsetConfig('search_embedding_column'); else await engine.setConfig('search_embedding_column', priorColumn);
      if (priorRegistry === null) await engine.unsetConfig('embedding_columns'); else await engine.setConfig('embedding_columns', priorRegistry);
      await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_recovery');
    }
  }
});

test('a source recreation rejects an old prepared code projection', async () => {
  for (const engine of engines) {
    const isolated = 'recreated-code-example';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [isolated]);
    const slug = (await importCodeFile(engine, 'recreated.ts', body, { sourceId: isolated, noEmbed: true })).slug;
    const before = (await readProjectionSnapshot(engine, slug, isolated))!;
    const projection = await preparePageProjection(before);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolated]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [isolated]);
    await importCodeFile(engine, 'recreated.ts', 'export const replacementExample = 2;', { sourceId: isolated, noEmbed: true });
    await expect(installPageProjection(engine, before, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await engine.getChunks(slug, { sourceId: isolated })).map(c => c.chunk_text).join('\n')).toContain('replacementExample');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolated]);
  }
});

test('a malformed code job stays diagnosable without starving later valid code jobs', async () => {
  for (const engine of engines) {
    const isolated = 'failed-code-example';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [isolated]);
    try {
      await engine.putPage('broken-ts', { type: 'code', page_kind: 'code', title: 'Missing origin', compiled_truth: body }, { sourceId: isolated });
      const slug = (await importCodeFile(engine, 'healthy.ts', body, { sourceId: isolated, noEmbed: true })).slug;
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug=$2', [isolated, slug]);
      await queuePageProjection(engine, isolated, slug, 'retry');
      await engine.executeRaw("UPDATE page_projection_jobs SET updated_at=now()-interval '1 minute' WHERE slug='broken-ts'");
      expect((await rebuildPendingPageProjections(engine, 1)).rebuilt).toBe(0);
      expect((await rebuildPendingPageProjections(engine, 1)).rebuilt).toBe(1);
      expect(await engine.executeRaw("SELECT reason FROM page_projection_jobs WHERE slug='broken-ts'")).toEqual([{ reason: 'rebuild_failed' }]);
      expect((await engine.getChunks(slug, { sourceId: isolated })).length).toBeGreaterThan(0);
    } finally { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolated]); }
  }
});

test('private code remains invisible remotely after keyless recovery', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'private');
    const page = (await engine.getPage(slug, { sourceId }))!;
    await engine.putPage(slug, { ...page, page_kind: 'code', frontmatter: { ...page.frontmatter, visibility: 'private' } }, { sourceId });
    await rebuildPendingPageProjections(engine, 100);
    expect((await engine.getChunks(slug, { sourceId })).length).toBeGreaterThan(0);
    expect(await engine.getChunks(slug, { sourceId, excludePrivate: true })).toEqual([]);
    expect((await engine.searchKeyword('alpha', { sourceId, excludePrivate: true })).some(row => row.slug === slug)).toBe(false);
  }
});

test('a newer code revision wins a delayed rebuild and interrupted projection work retries atomically', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'interrupted'); await unseal(engine, slug);
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
    const code = await preparePageProjection(prepared);
    await engine.putPage(slug, { type: 'code', page_kind: 'code', title: 'Changed', compiled_truth: 'export const newerExample = 9;', frontmatter: { file: 'interrupted.ts' } }, { sourceId });
    await expect(installPageProjection(engine, prepared, code.chunks, { seal: true, preserveEmbeddings: true, code: code.code })).rejects.toMatchObject({ code: 'revision_conflict' });
    const transaction = engine.transaction.bind(engine);
    let interrupted = false;
    const broken = new Proxy(engine, { get(target, key) {
      if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => transaction(tx => run(new Proxy(tx, { get(inner, prop) {
        if (prop === 'upsertChunks') return async () => { interrupted = true; throw new Error('simulated interruption'); };
        const value = Reflect.get(inner, prop, inner); return typeof value === 'function' ? value.bind(inner) : value;
      } })));
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await rebuildPendingPageProjections(broken, 100)).rebuilt).toBe(0);
    expect(interrupted).toBe(true);
    expect(await engine.getChunks(slug, { sourceId })).toEqual([]);
    expect(await engine.executeRaw('SELECT reason FROM page_projection_jobs WHERE slug=$1', [slug])).toEqual([{ reason: 'rebuild_failed' }]);
    expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBe(1);
    expect((await engine.getChunks(slug, { sourceId })).map(c => c.chunk_text).join('\n')).toContain('newerExample');
  }
});

test('managed reindex uses a durable guarded receipt without canonical writes or paid effects', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'managed');
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true');
    try {
      await expect(importCodeFile(engine, 'managed.ts', body, { sourceId, noEmbed: true, force: true })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
      const result = await runReindexCode(engine, { sourceId, noEmbed: true, force: true });
      expect(result.failed).toBe(0);
      expect(result.reindexed).toBeGreaterThan(0);
      expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
      const requests = await engine.executeRaw<{ state: string; revision: string }>('SELECT state,outcome->>\'revision\' AS revision FROM persistence_requests WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
      expect(requests).toEqual([{ state: 'committed', revision: before.revision }]);
      expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1', [sourceId])).toEqual([]);
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.softDeletePage(slug, { sourceId })));
      expect((await runReindexCode(engine, { sourceId, noEmbed: true, force: true })).failed).toBe(0);
      expect(await engine.getPage(slug, { sourceId })).toBeNull();
    } finally { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false'); }
  }
}), 120_000);

test('archived sources stay unsealed and are excluded from reindex', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'archived'); await unseal(engine, slug);
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
    try {
      expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBe(0);
      expect((await runReindexCode(engine, { sourceId, noEmbed: true, force: true })).codePages).toBe(0);
      expect(await engine.getChunks(slug, { sourceId })).toEqual([]);
    } finally { await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [sourceId]); }
  }
});

const WIPE_SYMBOLS = `UPDATE content_chunks SET symbol_name=NULL, symbol_type=NULL, language=NULL, symbol_name_qualified=NULL,
  parent_symbol_path=NULL WHERE page_id=$1`;
const basisVector = (at: number) => `[${Array.from({ length: 1536 }, (_, i) => i === at ? 1 : 0).join(',')}]`;

// Value: protects=metadata repair on a registry-column brain keeps that column's own vectors but never promotes the legacy `embedding` column; fails_when=reuseStoredEmbeddings always reads `embedding` (legacy vector copied into the active column) or stops reusing the active column; why_new=the existing registry-column test goes through rebuildPendingPageProjections, which never calls reuseStoredEmbeddings; seam=none
test('code metadata repair reuses only the active registry column vectors, never the legacy column', async () => {
  for (const engine of engines) {
    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_recovery vector(1536)');
    const priorColumn = await engine.getConfig('search_embedding_column');
    const priorRegistry = await engine.getConfig('embedding_columns');
    try {
      const slug = await seed(engine, 'repair-column');
      const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
      const pageId = prepared.snapshot.page.id;
      await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1',
        [pageId, basisVector(0), prepared.embeddingModel]);
      await engine.setConfig('embedding_columns', JSON.stringify({ embedding_recovery: { provider: prepared.embeddingModel, dimensions: 1536, type: 'vector' } }));
      await engine.setConfig('search_embedding_column', 'embedding_recovery');

      // Only the legacy column holds vectors: repair restores metadata and must not copy them across.
      await engine.executeRaw(WIPE_SYMBOLS, [pageId]);
      await reindexCodeProjection(engine, slug, sourceId, { force: true, noEmbed: true });
      let rows = await engine.executeRaw<{ symbol_name_qualified: string | null; active: string | null }>(
        'SELECT symbol_name_qualified, embedding_recovery::text AS active FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index', [pageId]);
      expect(rows.map(r => r.symbol_name_qualified).sort()).toEqual(['alpha', 'beta']);
      expect(rows.every(r => r.active === null)).toBe(true);

      // The active column holds valid vectors: repair keeps them while restoring metadata.
      await engine.executeRaw('UPDATE content_chunks SET embedding_recovery=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1',
        [pageId, basisVector(1), prepared.embeddingModel]);
      await engine.executeRaw(WIPE_SYMBOLS, [pageId]);
      await reindexCodeProjection(engine, slug, sourceId, { force: true, noEmbed: true });
      rows = await engine.executeRaw('SELECT symbol_name_qualified, (embedding_recovery::float4[])[2] AS second FROM content_chunks WHERE page_id=$1 ORDER BY chunk_index', [pageId]) as any;
      expect(rows.map(r => r.symbol_name_qualified).sort()).toEqual(['alpha', 'beta']);
      expect(rows.map((r: any) => Number(r.second))).toEqual([1, 1]);
    } finally {
      if (priorColumn === null) await engine.unsetConfig('search_embedding_column'); else await engine.setConfig('search_embedding_column', priorColumn);
      if (priorRegistry === null) await engine.unsetConfig('embedding_columns'); else await engine.setConfig('embedding_columns', priorRegistry);
      await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_recovery');
    }
  }
});

// Value: protects=a page with contextual retrieval enabled never inherits bare-text vectors during metadata repair; fails_when=the contextual_retrieval_mode early return in reuseStoredEmbeddings is removed; why_new=no test drives reindexCodeProjection on a contextual page whose chunks hold otherwise-valid vectors; seam=none
test('code metadata repair skips vector reuse on a contextual-retrieval page', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'repair-contextual');
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const pageId = prepared.snapshot.page.id;
    await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1',
      [pageId, basisVector(0), prepared.embeddingModel]);
    await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode='title' WHERE id=$1", [pageId]);
    await engine.executeRaw(WIPE_SYMBOLS, [pageId]);
    await reindexCodeProjection(engine, slug, sourceId, { force: true, noEmbed: true });
    const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
    expect(chunks.map(c => c.symbol_name_qualified).sort()).toEqual(['alpha', 'beta']);
    expect(chunks.every(c => c.embedding_is_null)).toBe(true);
  }
});

// Value: protects=metadata repair never re-stamps a vector produced by a different embedding model as current; fails_when=the `model=$2` predicate is dropped from reuseStoredEmbeddings' SELECT; why_new=the model-drift case is only covered through rebuildPendingPageProjections, never through the reuse query; seam=none
test('code metadata repair never reuses a vector recorded under another embedding model', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'repair-foreign-model');
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const pageId = prepared.snapshot.page.id;
    await engine.executeRaw("UPDATE content_chunks SET embedding=$2::vector,model='example:other',embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1",
      [pageId, basisVector(0)]);
    await engine.executeRaw(WIPE_SYMBOLS, [pageId]);
    await reindexCodeProjection(engine, slug, sourceId, { force: true, noEmbed: true });
    const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
    expect(chunks.map(c => c.symbol_name_qualified).sort()).toEqual(['alpha', 'beta']);
    expect(chunks.every(c => c.embedding_is_null)).toBe(true);
  }
});

// Value: protects=legacy vectors stored before text hashes were recorded survive metadata repair, matching installPageProjection's NULL-hash allowance; fails_when=the `embedded_text_hash IS NULL` allowance is dropped from reuseStoredEmbeddings' SELECT (repair silently unembeds every legacy page); why_new=other reuse tests only seed md5 or stale hashes; seam=none
test('code metadata repair keeps legacy vectors that carry no text hash', async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'repair-null-hash');
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const pageId = prepared.snapshot.page.id;
    await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=NULL WHERE page_id=$1',
      [pageId, basisVector(0), prepared.embeddingModel]);
    await engine.executeRaw(WIPE_SYMBOLS, [pageId]);
    await reindexCodeProjection(engine, slug, sourceId, { force: true, noEmbed: true });
    const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
    expect(chunks.map(c => c.symbol_name_qualified).sort()).toEqual(['alpha', 'beta']);
    expect(chunks.every(c => !c.embedding_is_null && c.embedding![0] === 1)).toBe(true);
  }
});

// Value: protects=the managed (journaled) reindex path restores wiped symbol metadata without discarding valid vectors; fails_when=prepareCodeReindex stops calling reuseStoredEmbeddings (managed repair silently leaves every chunk unembedded); why_new=the existing managed test only asserts receipts and revision, with no vectors present; seam=none
test('managed code metadata repair keeps valid vectors while restoring symbol metadata', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const slug = await seed(engine, 'managed-repair');
    const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const pageId = prepared.snapshot.page.id;
    await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_at=now(),embedded_text_hash=md5(chunk_text) WHERE page_id=$1',
      [pageId, basisVector(0), prepared.embeddingModel]);
    await engine.executeRaw(WIPE_SYMBOLS, [pageId]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true');
    try {
      const result = await runReindexCode(engine, { sourceId, noEmbed: true, force: true });
      expect(result.failed).toBe(0);
      const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
      expect(chunks.map(c => c.symbol_name_qualified).sort()).toEqual(['alpha', 'beta']);
      expect(chunks.every(c => !c.embedding_is_null && c.embedding![0] === 1)).toBe(true);
    } finally { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false'); }
  }
}), 120_000);
