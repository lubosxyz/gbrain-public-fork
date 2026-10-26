import type { BrainEngine } from '../core/engine.ts';
import type { EmbedResult } from './embed.ts';
import { serr } from '../core/console-prefix.ts';
import { buildChunkTokenLimitMarker } from '../core/embed-skip.ts';
import { describeOversizedInput, isEmbedInputOversized, partitionEmbedInputs } from '../core/embed-input-guard.ts';
import { AITransientError, isInputTooLargeError } from '../core/ai/errors.ts';
import { isEmbeddingZeroNormError } from '../core/ai/embedding-guard.ts';
import { isSingleInputOverLengthError, statusFromCause } from '../core/embed-overlength-heal.ts';
import { embedBatchKeepingUsable, embedBatchWithBackoff, isEmbedRetriableError, isTransientNetworkEmbedError, type EmbedBatchWithBackoffOpts } from '../core/embed-retry.ts';
import type { Chunk } from '../core/types.ts';
import { observed, type DbPacer } from '../core/db-pacer.ts';
const FAILURE_SAMPLE_CAP = 10;

export interface PageEmbedOutcome {
  embeddings: (Float32Array | null)[];
  /** Chunks that failed for a reason a later run could still resolve. */
  failed: number;
  /**
   * parked-chunk accounting: chunks that exceed the embedder's context window. Kept apart
   * from `failed` because the caller's response differs — a failure is
   * retried, a parked chunk is recorded and the page taken out of the embed
   * rotation. Both leave the chunk's embedding NULL.
   */
  parked: number;
  /** Longest parked chunk, in characters — what the skip marker records. */
  parkedBytes: number;
  /** First parked chunk's reason, for the operator-facing sample. */
  firstParkedDetail?: string;
  /**
   * Positions (in the caller's input array) of every parked chunk — the
   * caller maps them to chunk_index rows to carry provider verdicts across
   * keyset batches (round-3 P2).
   */
  parkedIndexes: number[];
  firstError?: unknown;
}

export async function embedPageTexts(
  texts: string[],
  opts: EmbedBatchWithBackoffOpts = {},
): Promise<PageEmbedOutcome> {
  const embeddings: (Float32Array | null)[] = new Array(texts.length).fill(null);
  let parked = 0;
  let parkedBytes = 0;
  let firstParkedDetail: string | undefined;
  const parkedIndexes: number[] = [];
  const park = (detail: string, chars: number, index: number) => {
    parked++;
    parkedBytes = Math.max(parkedBytes, chars);
    firstParkedDetail ??= detail;
    parkedIndexes.push(index);
  };

  // parked-chunk accounting, first line: never spend a provider call on a text that already
  // breaches gbrain's own chunk budget. Catches chunks left behind by an
  // older chunker version, which no re-chunk sweep has reached yet.
  const { sendable, sendableIndexes, oversized } = partitionEmbedInputs(texts);
  for (const o of oversized) park(describeOversizedInput(o), o.chars, o.index);
  if (sendable.length === 0) {
    return { embeddings, failed: 0, parked, parkedBytes, firstParkedDetail, parkedIndexes };
  }
  const scatter = (vectors: (Float32Array | null | undefined)[]) => {
    for (let i = 0; i < sendableIndexes.length; i++) {
      embeddings[sendableIndexes[i]] = vectors[i] ?? null;
    }
  };

  try {
    const { vectors, refused } = await embedBatchKeepingUsable(sendable, opts);
    scatter(vectors);
    if (refused) return { embeddings, failed: refused.failures.length, firstError: refused, parked, parkedBytes, firstParkedDetail, parkedIndexes };
    return { embeddings, failed: 0, parked, parkedBytes, firstParkedDetail, parkedIndexes };
  } catch (e: unknown) {
    if (opts.abortSignal?.aborted) throw e; // shutdown, not a chunk problem
    // parked-chunk accounting, second line: an over-context rejection is about ONE input, so
    // isolation is the only way to learn which. It fires even for a
    // single-text batch — the catch-up pass reaches a poisoned page with just
    // that one chunk left, and the pre-fix `texts.length <= 1` bail was what
    // turned it into an unbounded retry: rethrow, count a failure, exit
    // non-zero, come back tomorrow and rethrow the identical bytes.
    if (isEmbeddingZeroNormError(e)) throw e;
    if (!isInputTooLargeError(e)) {
      if (sendable.length <= 1) throw e; // nothing to isolate
      // #3374 — network-transient exhaustion isn't chunk-specific either:
      // fanning out during an outage multiplies failing calls per page.
      if (!isSingleInputOverLengthError(e) && (isEmbedRetriableError(e) || isTransientNetworkEmbedError(e) || e instanceof AITransientError)) throw e;
      const status = statusFromCause(e);
      if (status === 401 || status === 403) throw e;
    }

    let failed = 0;
    let firstError: unknown;
    for (let i = 0; i < sendable.length; i++) {
      const t = sendable[i];
      try {
        const single = await embedBatchWithBackoff([t], opts);
        embeddings[sendableIndexes[i]] = single[0] ?? null;
        if (single[0] === undefined) { failed++; firstError ??= e; }
      } catch (chunkErr: unknown) {
        if (opts.abortSignal?.aborted) throw chunkErr;
        if (isInputTooLargeError(chunkErr)) {
          park(chunkErr instanceof Error ? chunkErr.message : String(chunkErr), t.length, sendableIndexes[i]);
          continue;
        }
        failed++;
        firstError ??= chunkErr;
      }
    }
    // Total RETRYABLE failure keeps the pre-#3037 throw contract. A page whose
    // every chunk was parked is not a failure — it is a settled verdict, and
    // the caller records it as such.
    if (failed > 0 && failed === sendable.length) throw firstError ?? e;
    return { embeddings, failed, parked, parkedBytes, firstParkedDetail, parkedIndexes, firstError };
  }
}

/**
 * parked-chunk accounting: record a page's parked chunks once and take the page out of the
 * embed rotation, so "this chunk cannot be embedded" is stated a single time
 * instead of re-discovered on every run forever.
 *
 * Call AFTER the page's successful embeddings have been written — the marker
 * hides the page from later stale selection, so anything not persisted by
 * then stays unpersisted.
 */
export async function settleParkedChunks(
  engine: BrainEngine,
  result: EmbedResult,
  slug: string,
  sourceId: string | undefined,
  outcome: PageEmbedOutcome,
  totalChunks: number,
  unresolvedFailures = 0,
): Promise<void> {
  if (outcome.parked === 0) return;
  result.parked += outcome.parked;
  if (result.parked_samples.length < FAILURE_SAMPLE_CAP) {
    result.parked_samples.push(`${slug}: ${outcome.firstParkedDetail ?? 'exceeds the embedder context'}`);
  }
  // Round-3 P2: a transiently-failed sibling still needs the next stale run
  // to see this page — the marker would hide it. Count the parked chunks but
  // defer the marker until a pass with no unresolved failures.
  if (unresolvedFailures > 0) {
    serr(
      `\n  ${slug}: ${outcome.parked}/${totalChunks} chunk(s) exceed the embedder's context window — `
      + `embed_skip deferred: ${unresolvedFailures} sibling chunk(s) failed transiently and must stay retryable.`,
    );
    return;
  }
  serr(
    `\n  ${slug}: ${outcome.parked}/${totalChunks} chunk(s) exceed the embedder's context window — `
    + `parking the page (embed_skip: chunk_token_limit). Re-chunk it to index that content.`,
  );
  try {
    await engine.markEmbedSkip(slug, {
      sourceId,
      marker: buildChunkTokenLimitMarker(outcome.parkedBytes),
    });
  } catch (e: unknown) {
    // The marker is an optimization, not the guarantee: without it the next
    // run re-skips these chunks locally anyway (pre-guard) or re-learns the
    // verdict for one provider call. A failed write must not turn an
    // otherwise clean run red.
    serr(`  ${slug}: could not persist the embed-skip marker: ${e instanceof Error ? e.message : e}`);
  }
}

/** Delay parking until other batches have persisted every still-embeddable sibling. */
export async function settleStaleParkedChunks(engine: BrainEngine, result: EmbedResult, slug: string, sourceId: string, outcome: PageEmbedOutcome, stale: Pick<Chunk, 'chunk_index'>[], failed: number, key: string, providerParkedByPage: Map<string, Set<number>>, pacer: DbPacer): Promise<void> {
          if (outcome.parked > 0) {
            const known = providerParkedByPage.get(key) ?? new Set<number>();
            for (const idx of outcome.parkedIndexes) {
              const row = stale[idx];
              if (row) known.add(row.chunk_index);
            }
            providerParkedByPage.set(key, known);
            const staleIdxThisBatch = new Set(stale.map((c) => c.chunk_index));
            const fresh = await observed(pacer, () =>
              engine.getChunks(slug, { sourceId: sourceId, includeEmbedding: true }));
            const embeddableElsewhere = fresh.some((c) =>
              !staleIdxThisBatch.has(c.chunk_index)
              && !known.has(c.chunk_index)
              && c.embedding == null
              && !isEmbedInputOversized(c.chunk_text));
            if (!embeddableElsewhere) {
              await settleParkedChunks(engine, result, slug, sourceId, outcome, stale.length, failed);
            } else {
              result.parked += outcome.parked;
              if (result.parked_samples.length < FAILURE_SAMPLE_CAP) {
                result.parked_samples.push(`${slug}: ${outcome.firstParkedDetail ?? 'exceeds the embedder context'}`);
              }
              serr(
                `\n  ${slug}: ${outcome.parked}/${stale.length} chunk(s) exceed the embedder's context window — `
                + `embed_skip deferred: the page still has embeddable chunk(s) pending in a later batch.`,
              );
            }
          }
}
