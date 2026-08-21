/**
 * auth-gate.ts — the shared pre-handler auth resolver for tenant-scoped
 * tokens (v132 tenant-remediation lane).
 *
 * One decision point, consumed by BOTH HTTP MCP transports for every
 * tools/call (whoami included) and by the shared dispatcher
 * (src/mcp/dispatch.ts) as a fail-closed backstop for any caller that did
 * not already gate (`tenantGateDone`). The gate is a no-op for OAuth clients
 * and grandfathered legacy tokens (`auth.tenantScoped !== true`) — their
 * historical behavior, including availability under audit-sink outages, is
 * unchanged. For tenant-scoped tokens (minted via mintScopedTenantToken) the
 * posture is fail-closed and SERVER-AUTHORITATIVE:
 *
 *  - the token ROW is re-read by id on every decision, so revocation and
 *    expiry take effect immediately (closes the verify→dispatch TOCTOU
 *    window) and the decision keys off DB state, never a stale AuthInfo;
 *  - expiry is validated against server UTC time; a tenant row with NULL,
 *    invalid, or past expiry is denied;
 *  - the ONLY allowed grant is exactly ['read'] read from the ROW — a row
 *    whose scopes were widened out-of-band is refused, not honored;
 *  - any operation whose declared scope is not 'read' is denied pre-handler
 *    (write/admin dispatch can never reach a handler on this path);
 *  - the ALLOW decision requires a durably written audit row (2s hard
 *    timeout, src/core/auth-audit.ts). Audit timeout or persistence failure
 *    turns the allow into a DENY before the handler runs, and fires the
 *    independent redacted alert. A DENY stands regardless of audit outcome.
 *
 * The deny path performs no writes other than the audit row itself —
 * transports skip their request-log/SSE emission for gate denials.
 */

import type { AuthInfo } from './ops/contract.ts';
import type { SqlQuery } from './sql-query.ts';
import { normalizeTokenScopes } from './legacy-token-scope.ts';
import { hashToken } from './utils.ts';
import {
  writeAuthAudit,
  type AuthAlertSink,
  type WriteAuthAuditOptions,
} from './auth-audit.ts';

export interface AuthGateResult {
  allow: boolean;
  /** Machine-stable deny reason code; unset on allow. */
  reason?: string;
  /** Correlation id of the audit row (or attempted row) for this decision. */
  correlationId?: string;
}

export interface AuthGateOptions {
  timeoutMs?: number;
  alertSink?: AuthAlertSink;
  /** Clock injection for tests (epoch seconds). */
  nowEpochSeconds?: () => number;
}

/** The single grant shape a tenant-scoped token may carry. */
export function isExactReadGrant(scopes: readonly string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.length === 1 && scopes[0] === 'read';
}

/**
 * Resolve the auth decision for one MCP method. Never throws; the caller
 * maps `allow: false` to an error envelope WITHOUT dispatching the handler.
 */
export async function gateRemoteToolCall(
  sql: SqlQuery,
  auth: AuthInfo | undefined,
  opName: string,
  opScope: string,
  opts: AuthGateOptions = {},
): Promise<AuthGateResult> {
  // Grandfathered legacy tokens, OAuth clients, and auth-less transports:
  // the gate takes no decision — existing scope enforcement downstream
  // stays authoritative and behavior is byte-identical to pre-v132.
  if (!auth || auth.tenantScoped !== true) return { allow: true };

  const auditOpts: WriteAuthAuditOptions = {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.alertSink !== undefined ? { alertSink: opts.alertSink } : {}),
  };
  const base = {
    method: opName,
    tokenId: auth.tokenId,
    tokenName: auth.clientName ?? auth.clientId,
    companySlug: auth.companySlug,
    actor: auth.clientName ?? auth.clientId,
  };

  const deny = async (reason: string): Promise<AuthGateResult> => {
    // A deny stands whether or not its audit row lands (deny is the safe
    // direction); a failed write still fires the redacted alert inside
    // writeAuthAudit.
    const res = await writeAuthAudit(sql, { ...base, decision: 'deny', reason }, auditOpts);
    return { allow: false, reason, correlationId: res.correlationId };
  };

  // 1. Server-authoritative row re-check, BOUND TO THE PRESENTED BEARER:
  //    the lookup keys on (id AND token_hash), so a row replaced under the
  //    same UUID can never authorize the original credential. Every failure
  //    mode here — missing tokenId, malformed id, row gone/replaced, lookup
  //    error — is a DENY: a tenant-scoped AuthInfo without a resolvable live
  //    row for THIS bearer has no basis for access. (Pre-v132 brains can't
  //    reach this: tenantScoped is only set when the v132 projection
  //    succeeded.)
  let row: Record<string, unknown> | undefined;
  try {
    const rows = await sql`
      SELECT revoked_at, expires_at, scopes, company_slug FROM access_tokens
      WHERE id = ${auth.tokenId ?? ''}::uuid AND token_hash = ${hashToken(auth.token)}
    `;
    row = rows[0];
  } catch {
    return deny('token_lookup_failed');
  }
  if (!row) return deny('token_unknown');
  if (row.revoked_at != null) return deny('token_revoked');
  // Identity binding: the row's CURRENT tenant must match the verified
  // identity this request was authenticated as — a slug rewritten between
  // verification and dispatch must not be authorized (or audited) under
  // either the old or the new tenant.
  const rowSlug = typeof row.company_slug === 'string' ? row.company_slug : undefined;
  if (rowSlug !== auth.companySlug) return deny('token_identity_mismatch');

  // 2. Server-time expiry from the ROW. NULL/invalid expiry on a
  //    tenant-scoped row is a deny, never a synthetic grant.
  const rawExpiry = row.expires_at;
  const expMs = rawExpiry == null ? NaN : new Date(rawExpiry as string | Date).getTime();
  const now = (opts.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (Number.isNaN(expMs) || Math.floor(expMs / 1000) <= now) {
    return deny('token_expired');
  }

  // 3. Exact-grant check from the ROW: anything other than exactly ['read']
  //    is refused (a widened row is a tamper signal, not a grant).
  if (!isExactReadGrant(normalizeTokenScopes(row.scopes) ?? undefined)) {
    return deny('invalid_scope_grant');
  }

  // 4. Read-only dispatch: non-read ops are denied before the handler.
  if (opScope !== 'read') {
    return deny('insufficient_scope');
  }

  // 5. Allow — valid only once the audit row is durably written.
  const res = await writeAuthAudit(sql, { ...base, decision: 'verify' }, auditOpts);
  if (!res.ok) {
    return { allow: false, reason: 'audit_unavailable', correlationId: res.correlationId };
  }
  return { allow: true, correlationId: res.correlationId };
}
