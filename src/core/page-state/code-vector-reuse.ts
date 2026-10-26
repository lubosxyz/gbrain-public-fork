import type { BrainEngine } from '../engine.ts';
import type { ChunkInput } from '../types.ts';
import type { ResolvedColumn } from '../types.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { chunkGenerationProbe } from '../search/safe-chunks.ts';
import { planEmbeddingReuse } from '../embed-reuse.ts';
import { parseEmbedding } from '../utils.ts';
import { embeddingInputHash, type EmbeddingInputContext } from '../embedding-input-hash.ts';

/** Called under the page guard, before replacing code rows whose metadata changed. */
export async function reuseCodeProjectionVectors(engine: BrainEngine, pageId: number,
  mode: string | null | undefined, column: ResolvedColumn, provenance: EmbeddingInputContext, chunks: ChunkInput[]): Promise<void> {
  if (mode != null && mode !== 'none' || !provenance.model) return;
  const metadata = ['language', 'symbol_name', 'symbol_type', 'parent_symbol_path', 'symbol_name_qualified', 'doc_comment', 'start_line', 'end_line'] as const;
  const rows = await engine.executeRaw<{
    chunk_text: string; chunk_source: string; token_count: number | null; embedding: string;
    embedding_input_hash: string | null;
  } & Pick<ChunkInput, typeof metadata[number]>>(`SELECT ${metadata.join(',')},chunk_text,chunk_source,token_count,${quoteIdentifier(column.name)}::text AS embedding,embedding_input_hash
    FROM content_chunks cc WHERE page_id=$1 AND model=$2 AND ${quoteIdentifier(column.name)} IS NOT NULL AND ${chunkGenerationProbe('cc')}
      AND (embedded_text_hash IS NULL OR embedded_text_hash=md5(chunk_text)) ORDER BY chunk_index`,
  [pageId, provenance.model]);
  const stored = rows.filter(row => row.embedding_input_hash == null ? mode == null
    : row.embedding_input_hash === embeddingInputHash(provenance, 'none', row))
    .map(row => ({ ...row, embedding: parseEmbedding(row.embedding) }));
  // Metadata may change; the exact embedding input may not. Header-only changes
  // also require fresh vectors under the embedding-input provenance contract.
  const key = (chunk: { chunk_text: string; chunk_source?: string | null }) => JSON.stringify([chunk.chunk_source, chunk.chunk_text]);
  for (const [i, matched] of planEmbeddingReuse(stored, chunks, key).reuse) {
    const original = matched as typeof stored[number];
    if (metadata.some(field => original[field] != null && original[field] !== chunks[i]![field])) continue;
    chunks[i]!.embedding = matched.embedding!;
    chunks[i]!.token_count = matched.token_count ?? undefined;
    chunks[i]!.model = provenance.model;
    chunks[i]!.embedding_input_hash = embeddingInputHash(provenance, 'none', chunks[i]!);
  }
}
