/**
 * request-log retention — mcp_request_log retention.
 *
 * mcp_request_log is a pure append-only MCP usage log (no FK in or out).
 * A representative brain (a company brain) carries 246k rows / 88MB, growing
 * ~57MB/month — left unbounded it grows forever. This module prunes rows
 * past a TTL (default 30 days, configurable via the DB-plane config key
 * `cycle.purge.mcp_request_log_retention_days`) while preserving the
 * per-token `total_requests` / `last_used_at` metrics that serve-http's
 * admin `/admin/api/agents` endpoint otherwise computes LIVE over this
 * table (see src/commands/serve-http.ts). Every batch folds the deleted
 * rows' per-token count + max(created_at) into `mcp_request_log_purged`
 * (reconciliation migration v131) before dropping them, so those metrics survive the purge.
 *
 * Called from the dream cycle's purge phase (src/core/cycle.ts,
 * runPhasePurge), alongside purgeStaleVolunteerEvents / purgeStaleCheckpoints.
 */

import type { BrainEngine } from './engine.ts';

/** Default TTL when the DB-plane config key is unset. */
export const MCP_REQUEST_LOG_DEFAULT_TTL_DAYS = 30;

/**
 * DB-plane config key (read via `engine.getConfig()`, NOT the file-plane
 * `loadConfig()` — that's a documented footgun: file-plane config is
 * per-machine/CLI-invocation, DB-plane is the shared source of truth the
 * cycle purge phase (running wherever the dream cycle runs) actually reads).
 * Covered by the existing `cycle.` prefix in KNOWN_CONFIG_KEY_PREFIXES
 * (src/core/config.ts), so `gbrain config set` already accepts this key
 * without needing an explicit KNOWN_CONFIG_KEYS entry.
 */
export const MCP_REQUEST_LOG_RETENTION_CONFIG_KEY = 'cycle.purge.mcp_request_log_retention_days';

/** Rows deleted per DELETE statement. Kept well under any statement_timeout. */
const BATCH_SIZE = 2000;

/**
 * Safety valve on the number of batches a single call will run — bounds one
 * purge-phase invocation to at most BATCH_SIZE * MAX_BATCHES = 400k rows.
 * That's comfortably above the current one-time backlog (246k rows), so the
 * first run after this ships fully catches up; every run after that is a
 * small incremental delete (~57MB/month worth of rows). If a brain's backlog
 * ever exceeds the cap, the loop simply stops early and the next cycle run
 * continues where this one left off — never a partial-batch correctness
 * issue, just a multi-run catch-up.
 */
const MAX_BATCHES = 200;

/**
 * Delete `mcp_request_log` rows older than `ttlDays`, batched and
 * counter-preserving. Returns the total number of rows deleted.
 *
 * Fail-closed: if `mcp_request_log_purged` doesn't exist yet (brain hasn't
 * run reconciliation migration v131), this WARNs and returns 0 rather than either crashing
 * the purge phase or deleting rows without preserving their counters.
 */
export async function purgeStaleMcpRequestLog(
  engine: BrainEngine,
  ttlDays?: number,
): Promise<number> {
  try {
    const regclass = await engine.executeRaw<{ reg: string | null }>(
      `SELECT to_regclass('mcp_request_log_purged')::text AS reg`,
    );
    if (!regclass[0]?.reg) {
      console.warn(
        '[mcp-request-log-retention] mcp_request_log_purged table absent — skipping purge (migration v131 not yet applied on this brain)',
      );
      return 0;
    }

    const effectiveTtlDays = await resolveTtlDays(engine, ttlDays);

    let totalDeleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await engine.executeRaw<{ deleted_count: string | number }>(
        `WITH victims AS MATERIALIZED (
           SELECT id FROM mcp_request_log
           WHERE created_at < now() - ($1 || ' days')::interval
           ORDER BY id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ),
         deleted AS (
           DELETE FROM mcp_request_log
           WHERE id IN (SELECT id FROM victims)
           RETURNING token_name, created_at
         ),
         agg AS (
           SELECT token_name, count(*)::bigint AS n, max(created_at) AS mx
           FROM deleted
           WHERE token_name IS NOT NULL
           GROUP BY token_name
         ),
         ins AS (
           INSERT INTO mcp_request_log_purged AS p (token_name, purged_requests, purged_last_used_at)
           SELECT token_name, n, mx FROM agg
           ON CONFLICT (token_name) DO UPDATE SET
             purged_requests = p.purged_requests + EXCLUDED.purged_requests,
             purged_last_used_at = GREATEST(p.purged_last_used_at, EXCLUDED.purged_last_used_at)
           RETURNING 1
         )
         SELECT
           (SELECT count(*) FROM deleted)::bigint AS deleted_count,
           (SELECT count(*) FROM ins)::bigint AS purged_group_count`,
        [String(effectiveTtlDays), BATCH_SIZE],
      );
      const batchDeleted = Number(rows[0]?.deleted_count ?? 0);
      totalDeleted += batchDeleted;
      // A short batch means no more stale rows are claimable right now (either
      // genuinely none left, or the remainder is lock-contended — SKIP LOCKED
      // means those get picked up by the next cycle run). Stop looping.
      if (batchDeleted < BATCH_SIZE) break;
    }
    return totalDeleted;
  } catch (e) {
    console.error('[mcp-request-log-retention] purge failed:', (e as Error).message);
    return 0;
  }
}

/**
 * Resolve the effective TTL: explicit arg wins (tests / callers that want a
 * specific window); otherwise read the DB-plane config key, falling back to
 * the default on unset/invalid values. Never throws — a config read failure
 * (e.g. pre-`config` table brain) falls back to the default rather than
 * failing the whole purge.
 */
async function resolveTtlDays(engine: BrainEngine, ttlDays?: number): Promise<number> {
  // Floor at 1 whole day. A fractional/sub-day TTL would delete rows younger
  // than 24h, which the live-only `requests_today` / `error_rate` metrics
  // (serve-http.ts, 24h window) do NOT compensate for — they'd silently
  // undercount. Retention is a days-granularity policy; enforce it here.
  const floorDays = (value: number): number => Math.max(1, Math.floor(value));
  if (ttlDays !== undefined && Number.isFinite(ttlDays) && ttlDays > 0) {
    return floorDays(ttlDays);
  }
  try {
    const raw = await engine.getConfig(MCP_REQUEST_LOG_RETENTION_CONFIG_KEY);
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? floorDays(parsed) : MCP_REQUEST_LOG_DEFAULT_TTL_DAYS;
  } catch {
    return MCP_REQUEST_LOG_DEFAULT_TTL_DAYS;
  }
}
