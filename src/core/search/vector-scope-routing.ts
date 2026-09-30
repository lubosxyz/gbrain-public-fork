/**
 * Vector-arm plan routing by scope breadth (fork patch, 2026-09-27).
 *
 * Why this exists: `searchVector`'s inner CTE joins `content_chunks` to `pages`
 * and filters on the visibility predicate `p.text_projection_revision =
 * p.knowledge_revision`. Postgres estimates that column-to-column equality at
 * the default 0.5 % selectivity, while on a live brain it holds for ~93 % of
 * pages. For a scope covering (nearly) the whole brain — the federated source
 * list a grantless local MCP client sends — the planner therefore expects ~70
 * pages, starts from `pages`, and computes the exact distance for every chunk
 * of every page: 1.4M buffers and 14.6 s on a 158k-chunk brain, cancelled by
 * the 8 s statement timeout, so hybrid search silently degraded to keyword-only.
 * The HNSW-ordered plan for the same query touches ~3–4k buffers.
 *
 * A narrow scope is the opposite case: the `default` source of that brain holds
 * 9 % of pages but ~1 % of chunks, so a filtered HNSW scan under-fills the
 * candidate pool (36/50 rows measured) and the exact plan is correct.
 *
 * Routing: when the scope covers at least BROAD_SCOPE_PAGE_SHARE of live pages,
 * no other selective filter is present and the column is HNSW-indexed, the
 * engine sets `enable_sort = off` transaction-locally. That makes the explicit
 * distance Sort prohibitively expensive, so the planner picks the index-ordered
 * scan — the same forcing technique pgvector's regression suite and
 * test/vector-ef-search.test.ts use. Outer sorts are penalised equally in every
 * candidate plan, so only the choice of the candidate scan changes.
 *
 * Upstream v0.51.7 fixes the estimate itself (expression statistics + `IS TRUE`
 * predicate, migrations 160/161) and adds iterative scans; after that rebase the
 * broad case is planned correctly, but the narrow case then prefers a filtered
 * HNSW scan — keep routing narrow scopes to the exact plan when porting.
 * Measurements: agentic-os docs/ops/2026-09-27-gbrain-retrieval-latency.md.
 */

import type { SearchOpts } from '../types.ts';

/** Default page-share threshold above which a scope counts as "whole brain". */
export const BROAD_SCOPE_PAGE_SHARE_DEFAULT = 0.8;

/** Default lifetime of the cached per-source page counts. */
export const SOURCE_PAGE_COUNT_TTL_MS = 10 * 60_000;

export type SourcePageCounts = ReadonlyMap<string, number>;

/** Resolve the broad-scope threshold, honouring GBRAIN_VECTOR_FORCE_ANN_SHARE in (0, 1]. */
export function resolveBroadScopePageShare(): number {
  const raw = process.env.GBRAIN_VECTOR_FORCE_ANN_SHARE;
  if (raw === undefined || raw.trim() === '') return BROAD_SCOPE_PAGE_SHARE_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) return BROAD_SCOPE_PAGE_SHARE_DEFAULT;
  return value;
}

/** Fraction of live pages the search scope covers; 0 when counts are unknown. */
export function scopePageShare(
  counts: SourcePageCounts | null | undefined,
  opts: Pick<SearchOpts, 'sourceId' | 'sourceIds'>,
): number {
  if (!counts || counts.size === 0) return 0;
  let total = 0;
  for (const n of counts.values()) total += n;
  if (total <= 0) return 0;
  // Same precedence as the SQL scope clause: array form wins over the scalar.
  let scoped: Iterable<string> | null = null;
  if (opts.sourceIds && opts.sourceIds.length > 0) scoped = new Set(opts.sourceIds);
  else if (opts.sourceId) scoped = [opts.sourceId];
  if (scoped === null) return 1;
  let inScope = 0;
  for (const id of scoped) inScope += counts.get(id) ?? 0;
  return Math.min(1, inScope / total);
}

/** True when the vector arm must be steered onto the HNSW-ordered scan. */
export function shouldForceAnnScan(
  counts: SourcePageCounts | null | undefined,
  opts: SearchOpts,
  ctx: { hnswIndexed: boolean },
): boolean {
  if (process.env.GBRAIN_VECTOR_FORCE_ANN === 'off') return false;
  if (!ctx.hnswIndexed) return false;
  // Any other selective predicate shrinks the matching chunk set; forcing the
  // index there would under-fill the pool, so the planner keeps the choice.
  if (opts.type || (opts.types && opts.types.length > 0)) return false;
  if (opts.language || opts.symbolKind) return false;
  if (opts.afterDate || opts.beforeDate) return false;
  if (opts.detail === 'low') return false;
  return scopePageShare(counts, opts) >= resolveBroadScopePageShare();
}

/** Per-engine TTL cache for source page counts; a failed load yields null and is retried. */
export class SourcePageCountCache {
  private value: SourcePageCounts | null = null;
  private loadedAt = 0;

  constructor(
    private readonly ttlMs: number = SOURCE_PAGE_COUNT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Return cached counts, loading them when missing or older than the TTL. */
  async get(loader: () => Promise<SourcePageCounts>): Promise<SourcePageCounts | null> {
    if (this.value && this.now() - this.loadedAt <= this.ttlMs) return this.value;
    try {
      this.value = await loader();
      this.loadedAt = this.now();
      return this.value;
    } catch {
      this.value = null;
      return null;
    }
  }
}
