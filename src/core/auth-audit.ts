/**
 * auth-audit.ts — durable, REDACTED audit of auth decisions + the
 * independent operational alert path (v132 tenant-remediation lane).
 *
 * Contract (normative, from the approved tenant-remediation SPEC):
 *
 *  - One `auth_audit` row per auth decision: mint / verify / deny / revoke.
 *  - Rows are REDACTED: identifiers (token row id, token name, company slug,
 *    actor), a machine-stable reason code, a correlation id, and a
 *    server-stamped timestamp. NEVER raw token material, request payloads,
 *    or brain content. The writer takes only scalar fields by construction.
 *  - The write is bounded by a HARD timeout (AUTH_AUDIT_TIMEOUT_MS = 2s).
 *    Timeout and persistence failure are reported as `ok: false`; the writer
 *    itself NEVER throws and NEVER retries. What `ok: false` means is the
 *    caller's fail-closed decision: for tenant-scoped tokens the auth gate
 *    (src/core/auth-gate.ts) turns it into a pre-handler DENY.
 *  - Every failed write fires exactly one alert attempt through the
 *    independent alert sink: bounded, rate-limited, deduplicated, and
 *    redacted to {correlation_id, method, reason, ts}. Alert delivery
 *    failure is swallowed — it must never open access, call a handler, or
 *    trigger an auth retry.
 *
 * This is deliberately NOT built on the best-effort JSONL writers in
 * src/core/audit/ (invisible on remote server deploys — see
 * audit-writer.ts's own caveat) nor on mcp_request_log (best-effort by
 * design). Fail-closed semantics need a dedicated durable sink.
 */

import { randomUUID } from 'crypto';
import type { SqlQuery } from './sql-query.ts';

export type AuthDecision = 'mint' | 'verify' | 'deny' | 'revoke';

/** Normative hard timeout for the durable audit write (SPEC TM-GTR-D1). */
export const AUTH_AUDIT_TIMEOUT_MS = 2000;

export interface AuthAuditRecord {
  decision: AuthDecision;
  /** MCP method / operation name the decision was made for. */
  method?: string;
  /** Machine-stable reason code (deny reasons; optional context otherwise). */
  reason?: string;
  /** access_tokens.id of the subject token row (never the token value). */
  tokenId?: string;
  tokenName?: string;
  companySlug?: string;
  /** Server-stamped acting principal (minting principal name, token name). */
  actor?: string;
  /** Provided to correlate multi-row flows; generated when absent. */
  correlationId?: string;
}

export interface AuthAuditResult {
  ok: boolean;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Alert sink — the independent operational path for audit failures.
// ---------------------------------------------------------------------------

export interface AuthAlertPayload {
  correlation_id: string;
  method: string;
  reason: string;
  ts: string;
}

export interface AuthAlertSink {
  /** Never throws. Dedup/rate-limit decisions happen inside. */
  emit(alert: { correlationId: string; method?: string; reason: string }): void;
}

export interface AuthAlertSinkOptions {
  /** Delivery function; default writes one redacted line to stderr. */
  deliver?: (payload: AuthAlertPayload) => void;
  /** Dedup window per (method, reason) key. */
  dedupWindowMs?: number;
  /** Max delivered alerts per rolling window (across all keys). */
  maxPerWindow?: number;
  /** Bound on the dedup key map (oldest evicted beyond this). */
  maxKeys?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Bounded, deduplicated, rate-limited alert sink. All state is in-process:
 * the alert path must not depend on the very DB whose failure it reports.
 */
export function createAuthAlertSink(opts: AuthAlertSinkOptions = {}): AuthAlertSink {
  const deliver =
    opts.deliver ??
    ((payload: AuthAlertPayload) => {
      // One line, machine-parseable, redacted by construction of the payload.
      console.error(`[AUTH-AUDIT-ALERT] ${JSON.stringify(payload)}`);
    });
  const dedupWindowMs = opts.dedupWindowMs ?? 60_000;
  const maxPerWindow = opts.maxPerWindow ?? 10;
  const maxKeys = opts.maxKeys ?? 256;
  const now = opts.now ?? Date.now;

  // key -> last delivered timestamp. Insertion-ordered Map doubles as the
  // bounded eviction queue.
  const lastDelivered = new Map<string, number>();
  let windowStart = 0;
  let deliveredInWindow = 0;

  return {
    emit(alert) {
      try {
        const t = now();
        const key = `${alert.method ?? ''}|${alert.reason}`;
        const prev = lastDelivered.get(key);
        if (prev !== undefined && t - prev < dedupWindowMs) return;
        if (t - windowStart >= dedupWindowMs) {
          windowStart = t;
          deliveredInWindow = 0;
        }
        if (deliveredInWindow >= maxPerWindow) return;
        deliveredInWindow++;
        lastDelivered.delete(key);
        lastDelivered.set(key, t);
        while (lastDelivered.size > maxKeys) {
          const oldest = lastDelivered.keys().next().value;
          if (oldest === undefined) break;
          lastDelivered.delete(oldest);
        }
        deliver({
          correlation_id: alert.correlationId,
          method: alert.method ?? '',
          reason: alert.reason,
          ts: new Date(t).toISOString(),
        });
      } catch {
        // Alert delivery failure is safe by contract: no retry, no rethrow,
        // no effect on the (already fail-closed) auth decision.
      }
    },
  };
}

/** Process-wide default sink (stderr). Tests construct their own. */
export const defaultAuthAlertSink: AuthAlertSink = createAuthAlertSink();

// ---------------------------------------------------------------------------
// Durable audit write.
// ---------------------------------------------------------------------------

export interface WriteAuthAuditOptions {
  timeoutMs?: number;
  alertSink?: AuthAlertSink;
}

/**
 * Redaction boundary: every field that could carry caller-influenced text is
 * validated/normalized HERE, structurally, so no call-site mistake can put a
 * pasted secret (e.g. a bearer value sent as a tool name or a company slug)
 * into the audit table or the alert stream.
 */
const SAFE_METHOD_RE = /^[a-zA-Z0-9_/.:-]{1,64}$/;
const SAFE_REASON_RE = /^[a-z0-9_]{1,64}$/;
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function sanitizeAuditRecord(rec: AuthAuditRecord): AuthAuditRecord {
  return {
    decision: rec.decision,
    method:
      rec.method === undefined
        ? undefined
        : SAFE_METHOD_RE.test(rec.method)
          ? rec.method
          : 'unknown_operation',
    reason:
      rec.reason === undefined
        ? undefined
        : SAFE_REASON_RE.test(rec.reason)
          ? rec.reason
          : 'unspecified',
    tokenId: rec.tokenId?.slice(0, 64),
    // Server-derived identity strings (row name / verified principal) — clamp
    // length as a belt; they never carry caller request payloads.
    tokenName: rec.tokenName?.slice(0, 128),
    companySlug:
      rec.companySlug !== undefined && SAFE_SLUG_RE.test(rec.companySlug) ? rec.companySlug : undefined,
    actor: rec.actor?.slice(0, 128),
    correlationId: rec.correlationId,
  };
}

/**
 * Write one auth-decision row, bounded by the hard timeout. Returns
 * `{ ok, correlationId }`; never throws. `ok: false` covers persistence
 * failure AND timeout — the caller decides fail-closed consequences.
 */
export async function writeAuthAudit(
  sql: SqlQuery,
  rawRec: AuthAuditRecord,
  opts: WriteAuthAuditOptions = {},
): Promise<AuthAuditResult> {
  const rec = sanitizeAuditRecord(rawRec);
  const correlationId = rec.correlationId ?? randomUUID();
  const timeoutMs = opts.timeoutMs ?? AUTH_AUDIT_TIMEOUT_MS;
  const sink = opts.alertSink ?? defaultAuthAlertSink;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const insert = sql`
      INSERT INTO auth_audit (correlation_id, decision, method, reason, token_id, token_name, company_slug, actor)
      VALUES (${correlationId}, ${rec.decision}, ${rec.method ?? null}, ${rec.reason ?? null},
              ${rec.tokenId ?? null}, ${rec.tokenName ?? null}, ${rec.companySlug ?? null}, ${rec.actor ?? null})
    `;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const raced = await Promise.race([insert.then(() => 'ok' as const), timeout]);
    if (raced === 'timeout') {
      // The insert keeps running past the timeout loss. The DECISION is
      // already deny (the caller fail-closes on ok:false) — so if the slow
      // insert eventually lands, chase it with a correction row under the
      // same correlation id so the durable record never claims an allow
      // that was actually denied. Both chained branches swallow: a
      // slow-then-failing write can't become an unhandledRejection.
      insert
        .then(() =>
          sql`
            INSERT INTO auth_audit (correlation_id, decision, method, reason)
            VALUES (${correlationId}, ${'deny'}, ${rec.method ?? null}, ${'audit_timeout_superseded'})
          `,
        )
        .catch(() => {});
      sink.emit({ correlationId, method: rec.method, reason: 'audit_timeout' });
      return { ok: false, correlationId };
    }
    return { ok: true, correlationId };
  } catch {
    sink.emit({ correlationId, method: rec.method, reason: 'audit_persistence_failure' });
    return { ok: false, correlationId };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
