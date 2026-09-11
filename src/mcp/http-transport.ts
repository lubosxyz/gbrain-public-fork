/**
 * HTTP transport for `gbrain serve --http` (legacy bearer-auth path).
 *
 * Engine-aware via SqlQuery (works on both Postgres and PGLite as of the
 * v0.31 wave). The access_tokens and mcp_request_log tables exist on both
 * engines (see src/core/pglite-schema.ts:478,495 and src/schema.sql).
 *
 * Security model:
 *   - Every request must include `Authorization: Bearer <token>` (except /health)
 *   - Tokens are validated against SHA-256 hashes in the access_tokens table
 *   - Create/manage tokens with auth.ts (gbrain auth create/list/revoke)
 *   - No open OAuth, no client_credentials, no self-service tokens
 *
 * Hardening:
 *   - CORS default-deny: allowlist via GBRAIN_HTTP_CORS_ORIGIN (comma-separated)
 *   - Rate limit: per-IP pre-auth (protects DB from brute-force load) + per-token-id post-auth
 *     (limits runaway clients). Default 30 req/min per IP, 60 req/min per token. Bounded LRU
 *     so attacker-controlled keys can't grow memory unbounded.
 *   - Body cap: 1 MiB default (GBRAIN_HTTP_MAX_BODY_BYTES). Stream-counted, not buffered —
 *     chunked transfers without Content-Length are still capped.
 *   - last_used_at debounce: only one UPDATE per token per 60s (SQL-level WHERE clause).
 *   - mcp_request_log: one row per request with token_name + operation + status + latency.
 *
 * Replaces the standalone HTTP+OAuth wrapper that was vulnerable to unauthenticated
 * client registration (see SECURITY.md).
 */

import { createHash } from 'crypto';
import { hasScope } from '../core/scope.ts';
import type { BrainEngine } from '../core/engine.ts';
import { buildToolDefs } from './tool-defs.ts';
import { resolveMcpInstructions } from './instructions.ts';
import { resolveWritebackConfig, ambientOptsFrom } from '../core/facts/writeback-config.ts';
import { operations, operationsByName } from '../core/operations.ts';
import type { AuthInfo } from '../core/operations.ts';
import { gateRemoteToolCall } from '../core/auth-gate.ts';
import { writeAuthAudit } from '../core/auth-audit.ts';
import { isUndefinedColumnError } from '../core/utils.ts';
import { VERSION } from '../version.ts';
import { dispatchToolCall, requestLogStatusForResult } from './dispatch.ts';
import { parseStrictParamsMode } from './validate-params.ts';
import { filterOpsForSurface, clampSurface, type McpSurface } from './surface.ts';
import { disabledOpsForPublishGates } from './publish-gates.ts';
import { loadConfig } from '../core/config.ts';
import { buildDefaultLimiters, type RateLimiter } from './rate-limit.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { degradedLastError, isEngineDegraded } from '../core/degraded-marker.ts';
import { classifyPgAccessError } from '../core/pg-access-classify.ts';
import { redactConnectionInfo } from '../core/audit/redact-connection-info.ts';
import { redactUrlsInText } from '../core/url-redact.ts';
import { normalizeTokenScopes, parseLegacyTokenScope, parseTakesHoldersAllowList, coerceLegacyPermissions } from '../core/legacy-token-scope.ts';
export { parseLegacyTokenScope };

const DEFAULT_BODY_CAP = 1024 * 1024; // 1 MiB

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCorsAllowlist(): Set<string> | null {
  const v = process.env.GBRAIN_HTTP_CORS_ORIGIN;
  if (!v) return null;
  return new Set(v.split(',').map(s => s.trim()).filter(Boolean));
}

interface HttpTransportOptions {
  port: number;
  engine: BrainEngine;
  /** Override limiters (for tests). Defaults to env-driven buildDefaultLimiters. */
  limiters?: { ip: RateLimiter; token: RateLimiter };
  /**
   * MEMORY_VERBS v1 [c1]: tool-surface mode for this transport (the SECOND
   * HTTP path — the OAuth path in serve-http.ts carries its own). 'verbs' =
   * exactly the seven protocol verbs; 'starter' (WP4) = the STARTER_OPS
   * daily-driver set; 'full' (default) = everything. Legacy bearer tokens
   * have no oauth_clients row, so there is no per-client surface here — the
   * transport surface (clamped by GBRAIN_MCP_FORCE_SURFACE, narrow-only)
   * applies to every caller.
   */
  surface?: McpSurface;
}

interface AuthResult {
  ok: boolean;
  /**
   * v132: the deny was a TENANT-token auth decision already recorded in
   * auth_audit (expired / revoked / damaged metadata). The 401 branch skips
   * its `mcp_request_log(auth_failed)` write for these — a tenant deny
   * writes nothing beyond its audit row. Grandfathered denies keep the
   * historical request-log behavior.
   */
  tenantDeny?: boolean;
  tokenId?: string;
  tokenName?: string;
  /** v0.28: per-token allow-list for takes.holder. Default ['world'] when permissions row absent. */
  takesHoldersAllowList?: string[];
  /**
   * v0.34.1 (#861, D13): source-isolation scope for the auth'd request.
   * Legacy bearer tokens here default to 'default' to match the v0.33
   * effective behavior (the now-removed serve-http.ts fallback chain).
   * Operators migrate to the full OAuth transport (gbrain serve --http)
   * for narrower scoping.
   */
  sourceId?: string;
  /**
   * #1336: AuthInfo carrying the legacy token's stored federated_read grant
   * (`permissions.source_id` array). Threaded so `sourceScopeOpts` can scope
   * read ops to the operator-granted sources instead of just scalar `sourceId`.
   * Bounded to the stored grant — never widened to "all".
   */
  auth?: AuthInfo;
  /**
   * #3242: true when the token row carries an operator-set
   * `permissions.source_id` (string OR array — even a malformed one, which
   * fails closed to 'default' without widening). false = the historical
   * no-grant 'default' floor; ONLY that case gets the federated read set
   * (config.federated sources) threaded as localFederatedSourceIds.
   */
  hasSourceGrant?: boolean;
}

/* Legacy token source-scope parsing lives in core/legacy-token-scope.ts and is
 * re-exported above so the legacy HTTP transport and OAuth provider cannot drift. */

/** Read up to `cap` bytes off req.body. Returns null if cap exceeded. */
async function readBodyWithCap(req: Request, cap: number): Promise<string | null> {
  const cl = req.headers.get('content-length');
  if (cl) {
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n > cap) return null;
  }
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* noop */ }
      return null;
    }
    chunks.push(value);
  }
  // Concatenate without Buffer to keep this Node-vs-Bun-portable.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Resolve client IP. Honors X-Forwarded-For only when GBRAIN_HTTP_TRUST_PROXY=1. */
function resolveClientIp(req: Request, server: { requestIP: (r: Request) => { address: string } | null }): string {
  if (process.env.GBRAIN_HTTP_TRUST_PROXY === '1') {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const xRealIp = req.headers.get('x-real-ip');
    if (xRealIp) return xRealIp.trim();
  }
  const sock = server.requestIP(req);
  return sock?.address || 'unknown';
}

export async function startHttpTransport(opts: HttpTransportOptions) {
  const { port, engine } = opts;

  // Engine-aware: route SQL through the active BrainEngine. Both Postgres
  // and PGLite carry access_tokens + mcp_request_log in their schemas
  // (pglite-schema.ts:478,495 and schema.sql), so the legacy bearer-auth
  // path works on either engine without a postgres.js singleton.
  const sql = sqlQueryForEngine(engine);

  // Classified reason for the /health degraded payload — read-only on the
  // stored startup error, wrapped so a classifier bug degrades to a generic
  // token rather than failing the health endpoint.
  const degradedHealthReason = (): string => {
    try {
      const err = degradedLastError(engine);
      return err === undefined ? 'startup_connect_failed' : classifyPgAccessError(err, {}).reason;
    } catch {
      return 'startup_connect_failed';
    }
  };

  const limiters = opts.limiters || buildDefaultLimiters();
  const bodyCap = envInt('GBRAIN_HTTP_MAX_BODY_BYTES', DEFAULT_BODY_CAP);
  const corsAllowlist = parseCorsAllowlist();
  // MEMORY_VERBS v1 [c1]: surface filter applies to THIS transport too —
  // the advertised list AND dispatch (allowedOps), fail-closed. WP4: the
  // GBRAIN_MCP_FORCE_SURFACE kill switch min()s in (narrow-only, FOV-6a);
  // resolved once at startup — this transport builds its tool list once.
  const surface = clampSurface(opts.surface ?? 'full');
  // WP1/D7: this is a network transport — localOnly ops (operator-filesystem
  // reach) never appear in its catalog, matching serve-http's filter. The
  // dispatch-layer backstop denies them even if a caller guesses the name.
  const surfacedOps = filterOpsForSurface(operations.filter(op => !op.localOnly), surface);
  const surfaceAllowedOps: ReadonlySet<string> | undefined =
    surface === 'full' ? undefined : new Set(surfacedOps.map(o => o.name));
  // WP3: strict-params schema emission resolved ONCE at startup from the FILE
  // config plane — this transport builds its tool list once, so a
  // `mcp.strict_params` flip needs a restart here (deliberate; the OAuth
  // serve-http path re-reads dual-plane per request). Dispatch-side
  // enforcement still resolves per call.
  const fileConfig = loadConfig();
  const strictParams = parseStrictParamsMode(fileConfig?.mcp?.strict_params) === 'reject';
  const tools = buildToolDefs(surfacedOps, { strictParams });

  /**
   * v0.41.3 (T6): single consolidated CORS header builder. Pre-fix there were
   * two parallel functions (`corsHeaders` for actual requests, `corsPreflightHeaders`
   * for OPTIONS) — the preflight variant unconditionally emitted
   * `Access-Control-Allow-Methods` + `Access-Control-Allow-Headers` to EVERY
   * Origin, leaking the API surface to attackers probing the preflight. The
   * actual-request path was correctly default-deny.
   *
   * One function, one allowlist gate. Methods/Headers only emit when
   * preflight=true AND origin is allowlisted. Allow-Origin emits only when
   * origin is allowlisted (unchanged). `Vary: Origin` pairs with Allow-Origin
   * so caches don't serve allowlisted responses to non-allowlisted requests.
   *
   * `extra` is for response-specific headers (Retry-After, etc.) and is
   * never gated by the allowlist.
   */
  interface CorsHeaderOpts {
    preflight?: boolean;
    extra?: Record<string, string>;
  }
  function corsHeaders(origin: string | null, opts: CorsHeaderOpts = {}): Record<string, string> {
    const { preflight = false, extra = {} } = opts;
    const headers: Record<string, string> = { ...extra };
    const allowed = corsAllowlist && origin && corsAllowlist.has(origin);
    if (allowed) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
      if (preflight) {
        headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Accept';
      }
    }
    return headers;
  }

  async function validateToken(authHeader: string | null): Promise<AuthResult> {
    if (!authHeader?.startsWith('Bearer ')) return { ok: false };
    const token = authHeader.slice(7);
    const hash = hashToken(token);
    try {
      // v132 tenant-remediation lane: read tenant/mint metadata too. The
      // degrade rung fires ONLY on a missing column (pre-v132 brain,
      // grandfathered semantics) — any other error is a fail-closed deny.
      // A broad catch here would let a transient error reclassify a tenant
      // token as a grandfathered full-access bearer.
      let row: Record<string, unknown> | undefined;
      try {
        [row] = await sql`
          SELECT id, name, permissions, scopes, company_slug, expires_at FROM access_tokens
          WHERE token_hash = ${hash} AND revoked_at IS NULL
        `;
      } catch (err) {
        if (
          !isUndefinedColumnError(err, 'company_slug') &&
          !isUndefinedColumnError(err, 'expires_at') &&
          !isUndefinedColumnError(err, 'scopes')
        ) {
          return { ok: false };
        }
        [row] = await sql`
          SELECT id, name, permissions FROM access_tokens
          WHERE token_hash = ${hash} AND revoked_at IS NULL
        `;
      }
      if (!row) {
        // v132: distinguish a revoked token (auditable identity) from an
        // unknown one, mirroring verifyAccessToken. Degrades silently on
        // pre-v132 brains; the deny below stands either way.
        try {
          const [revoked] = await sql`
            SELECT id, name, company_slug FROM access_tokens
            WHERE token_hash = ${hash} AND revoked_at IS NOT NULL
          `;
          if (revoked) {
            const revokedSlug = typeof revoked.company_slug === 'string' ? revoked.company_slug : undefined;
            await writeAuthAudit(sql, {
              decision: 'deny',
              method: 'token_verify',
              reason: 'token_revoked',
              tokenId: revoked.id != null ? String(revoked.id) : undefined,
              tokenName: typeof revoked.name === 'string' ? revoked.name : undefined,
              companySlug: revokedSlug,
            });
            if (revokedSlug !== undefined) return { ok: false, tenantDeny: true };
          }
        } catch { /* pre-v132 projection — unaudited deny stands */ }
        return { ok: false };
      }
      const rowId = row.id as string;
      const rowName = row.name as string;
      const companySlug = typeof row.company_slug === 'string' ? row.company_slug : undefined;
      // v132: server-time expiry enforcement for tenant-scoped short-TTL
      // tokens (expires_at NULL = grandfathered, never expires — but a
      // tenant row missing its expiry is a deny, never a grant). Audited,
      // fail-closed, BEFORE the last_used_at touch — a deny performs no
      // writes here beyond the audit row.
      const rawExpiry = row.expires_at;
      const expMs = rawExpiry == null ? undefined : new Date(rawExpiry as string | Date).getTime();
      const expiryInvalid = expMs !== undefined && (Number.isNaN(expMs) || expMs <= Date.now());
      const tenantMissingExpiry = companySlug !== undefined && expMs === undefined;
      if (expiryInvalid || tenantMissingExpiry) {
        await writeAuthAudit(sql, {
          decision: 'deny',
          method: 'token_verify',
          reason: tenantMissingExpiry ? 'invalid_token_metadata' : 'token_expired',
          tokenId: rowId,
          tokenName: rowName,
          companySlug,
        });
        return { ok: false, tenantDeny: true };
      }
      const tenantScoped = companySlug !== undefined || rawExpiry != null;
      // Debounced last_used_at update — grandfathered tokens only (tenant
      // rows must leave zero non-audit writes behind a later gate deny).
      // SQL-level WHERE clause keeps this race-tolerant even under concurrent requests.
      if (!tenantScoped) {
        sql`UPDATE access_tokens
            SET last_used_at = now()
            WHERE id = ${rowId}
              AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`
          .catch(() => { /* fire-and-forget */ });
      }
      // v0.28: extract per-token takes-holder allow-list. Fail-safe default
      // is ['world'] — a token with no permissions row sees public claims only.
      // #2529: decode + parse via the shared core helpers so this transport and
      // the OAuth provider behind `serve --http` cannot drift — including a
      // double-encoded jsonb string scalar (#2339 class), which both now decode
      // identically instead of one honoring the grant while the other fails
      // open to ['world'].
      const perms = coerceLegacyPermissions((row as { permissions?: unknown }).permissions);
      const allowList = parseTakesHoldersAllowList(perms?.takes_holders) ?? ['world'];
      // #1336: honor the operator-set source grant stored on the token.
      const { sourceId, allowedSources } = parseLegacyTokenScope(perms?.source_id);
      const auth: AuthInfo = {
        token,
        clientId: rowId,
        principal: { kind: 'legacy_token', id: rowId },
        clientName: rowName,
        // v132: server-derived token kind (this transport only verifies
        // access_tokens rows).
        tokenKind: 'legacy',
        // v132: tenant-scoped tokens thread their REAL stored grant (the
        // gate requires exactly ['read']). Non-tenant tokens honor a stored
        // scopes grant; grandfathered (NULL-scopes) rows keep full access (#4043).
        scopes: tenantScoped
          ? (normalizeTokenScopes(row.scopes) ?? [])
          : (normalizeTokenScopes(row.scopes) ?? ['read', 'write', 'admin']),
        sourceId,
        ...(allowedSources ? { allowedSources } : {}),
        // v132: tenant threading — whoami reports company_slug from HERE
        // (server-derived), and the shared auth gate keys its fail-closed
        // posture off tenantScoped.
        ...(companySlug !== undefined ? { companySlug } : {}),
        tokenId: rowId,
        ...(tenantScoped ? { tenantScoped: true } : {}),
        ...(rawExpiry != null
          ? { expiresAt: Math.floor(new Date(rawExpiry as string | Date).getTime() / 1000) }
          : {}),
      };
      return {
        ok: true,
        tokenId: rowId,
        tokenName: rowName,
        takesHoldersAllowList: allowList,
        // v0.34.1 (#861, D13): legacy bearer tokens default to 'default'
        // source unless the token carries an explicit grant (#1336 above).
        sourceId,
        auth,
        // #3242: distinguish "operator granted a scope" from "historical
        // no-grant floor" — only the latter widens to federated sources.
        hasSourceGrant: perms?.source_id != null,
      };
    } catch {
      return { ok: false };
    }
  }

  function logRequest(tokenName: string | null, operation: string, status: string, latencyMs: number) {
    sql`INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
        VALUES (${tokenName}, ${operation}, ${latencyMs}, ${status})`
      .catch(() => { /* best-effort */ });
  }

  const server = Bun.serve({
    port,
    async fetch(req, server) {
      const startedMs = Date.now();
      const url = new URL(req.url);
      const path = url.pathname;
      const origin = req.headers.get('origin');

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders(origin, { preflight: true }) });
      }

      // Health check — no auth, no rate limit. Probes the DB so orchestration
      // doesn't see "ok" while clients are getting misleading 401s during a DB outage.
      if (path === '/health') {
        // Startup-degraded serve (db-availability 4c): report the classified
        // state WITHOUT touching the engine — a health poller must never
        // consume (or storm) the one lazy reconnect attempt.
        if (isEngineDegraded(engine)) {
          return Response.json(
            { status: 'degraded', version: VERSION, transport: 'http', db: 'unreachable', reason: degradedHealthReason() },
            { status: 503, headers: corsHeaders(origin) },
          );
        }
        try {
          await sql`SELECT 1`;
          return Response.json(
            { status: 'ok', version: VERSION, transport: 'http', db: 'ok' },
            { headers: corsHeaders(origin) },
          );
        } catch (e: any) {
          // Redacted: a driver message can embed the full DSN, and /health is
          // unauthenticated by design.
          const safe = redactUrlsInText(redactConnectionInfo(e?.message ?? 'unknown'));
          return Response.json(
            { status: 'unhealthy', version: VERSION, transport: 'http', db: 'unreachable', error: safe },
            { status: 503, headers: corsHeaders(origin) },
          );
        }
      }

      if (path !== '/mcp') {
        return Response.json({ error: 'not_found' }, { status: 404, headers: corsHeaders(origin) });
      }
      if (req.method !== 'POST') {
        return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders(origin) });
      }

      const ip = resolveClientIp(req, server);

      // Pre-auth IP rate limit. Fires BEFORE the DB lookup so we actually limit brute-force load.
      const ipCheck = limiters.ip.check(ip);
      if (!ipCheck.allowed) {
        logRequest(null, 'unknown', 'rate_limited', Date.now() - startedMs);
        return Response.json(
          { error: 'rate_limited', message: 'Too many requests' },
          {
            status: 429,
            headers: corsHeaders(origin, { extra: { 'Retry-After': String(ipCheck.retryAfter ?? 60) } }),
          },
        );
      }

      // Body cap (stream-counted; chunked transfers caught here, not at req.json).
      const bodyText = await readBodyWithCap(req, bodyCap);
      if (bodyText === null) {
        logRequest(null, 'unknown', 'body_too_large', Date.now() - startedMs);
        return Response.json(
          { error: 'payload_too_large', message: `Request body exceeds ${bodyCap} bytes` },
          { status: 413, headers: corsHeaders(origin) },
        );
      }

      // Auth.
      const auth = await validateToken(req.headers.get('Authorization'));
      if (!auth.ok) {
        // v132: a tenant deny is already durably recorded in auth_audit and
        // must leave no other writes behind; grandfathered/unknown denies
        // keep the historical auth_failed request-log row.
        if (!auth.tenantDeny) {
          logRequest(null, 'unknown', 'auth_failed', Date.now() - startedMs);
        }
        return Response.json(
          { error: 'invalid_token', message: 'Bearer token required. Create one: gbrain auth create <name>' },
          { status: 401, headers: corsHeaders(origin) },
        );
      }

      // Post-auth token-id rate limit. Limits runaway authed clients.
      const tokCheck = limiters.token.check(auth.tokenId!);
      if (!tokCheck.allowed) {
        logRequest(auth.tokenName!, 'unknown', 'rate_limited', Date.now() - startedMs);
        return Response.json(
          { error: 'rate_limited', message: 'Too many requests for this token' },
          {
            status: 429,
            headers: corsHeaders(origin, { extra: { 'Retry-After': String(tokCheck.retryAfter ?? 60) } }),
          },
        );
      }

      // Parse JSON-RPC body.
      let body: { method?: string; params?: any; id?: any };
      try {
        body = JSON.parse(bodyText);
      } catch (e: any) {
        logRequest(auth.tokenName!, 'unknown', 'parse_error', Date.now() - startedMs);
        return Response.json(
          { error: 'parse_error', message: e?.message ?? 'invalid JSON' },
          { status: 400, headers: corsHeaders(origin) },
        );
      }

      const { method, params, id } = body;

      // v132 tenant-remediation lane: on the tenant path EVERY MCP method is
      // an audited auth decision — initialize and tools/list included (with
      // the audit sink down, a tenant token gets nothing, not even the
      // handshake or the catalog). No-op for grandfathered tokens. The deny
      // path emits no request-log row (the audit row is the record).
      if (auth.auth?.tenantScoped === true && (method === 'initialize' || method === 'tools/list')) {
        const methodGate = await gateRemoteToolCall(sql, auth.auth, method, 'read');
        if (!methodGate.allow) {
          return Response.json(
            {
              error: methodGate.reason === 'audit_unavailable' ? 'audit_unavailable' : 'permission_denied',
              message: `${method} denied by the auth gate (${methodGate.reason ?? 'denied'}).`,
              correlation_id: methodGate.correlationId,
            },
            { status: 403, headers: corsHeaders(origin) },
          );
        }
      }

      // initialize
      if (method === 'initialize') {
        logRequest(auth.tokenName!, 'initialize', 'success', Date.now() - startedMs);
        // Ambient writeback (opt-in, default off): resolved per initialize —
        // fail-closed with a per-engine last-known-good bundle, so a config
        // read failure serves the previous bundle (or the base string), never
        // a wrong posture. The advertised writeback also respects token scopes —
        // extract_facts is advertised only when the resolved surface can
        // actually call it (OV2-14; a verbs/starter-pinned serve must not
        // order agents to call a tool dispatch will deny).
        const writeback = await resolveWritebackConfig(engine, fileConfig);
        return Response.json(
          {
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'gbrain', version: VERSION },
              capabilities: { tools: {} },
              // #4748: contract (+ opt-in writeback section) + deployment identity.
              instructions: resolveMcpInstructions(fileConfig, process.env, {
                writeback: ambientOptsFrom(writeback, {
                  remember: hasScope(auth.auth!.scopes, 'write') && (!surfaceAllowedOps || surfaceAllowedOps.has('remember')),
                  extractFacts: hasScope(auth.auth!.scopes, 'write') && (!surfaceAllowedOps || surfaceAllowedOps.has('extract_facts')),
                }),
              }),
            },
            jsonrpc: '2.0',
            id,
          },
          { headers: corsHeaders(origin) },
        );
      }

      // notifications/initialized — acknowledge with 204
      if (method === 'notifications/initialized') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      // tools/list
      if (method === 'tools/list') {
        // WP1/E5 truthful catalog on THIS transport too: publish-gated ops
        // (`Operation.publishGateKey`) are hidden while their gate resolves
        // off. Read per request (dual-plane, DB > file > false) so a
        // `gbrain config set mcp.publish_skills true` takes effect on the
        // next list with no restart — matching the OAuth transport. The
        // resolver never throws (read failure = hidden, the fail-closed
        // consent posture); the in-handler gates stay as the call-time
        // backstop. Pre-fix this transport listed the gated ops
        // unconditionally, so gates-off served the exact listed-but-denied
        // catalog lie E5 (test/truthful-catalog.e2e-lite.test.ts) pins out.
        const gateDisabled = await disabledOpsForPublishGates(engine, fileConfig);
        const visibleTools = tools.filter(t => {
          const op = operationsByName[t.name];
          return op && !gateDisabled.has(t.name) && (hasScope(auth.auth!.scopes, op.scope ?? 'read')
            || (op.agentCallable === true && hasScope(auth.auth!.scopes, 'agent')));
        });
        logRequest(auth.tokenName!, 'tools/list', 'success', Date.now() - startedMs);
        return Response.json(
          { result: { tools: visibleTools }, jsonrpc: '2.0', id },
          { headers: corsHeaders(origin) },
        );
      }

      // tools/call — dispatch through shared dispatch.ts (parity with stdio)
      if (method === 'tools/call') {
        const toolName: string = params?.name ?? 'unknown';
        const args: Record<string, unknown> = params?.arguments ?? {};
        // v132 tenant-remediation lane: the same shared pre-handler auth gate
        // as the OAuth transport (no-op for grandfathered tokens; row
        // re-check + fail-closed expiry + exact-['read'] + audited-allow for
        // tenant-scoped tokens). Deny writes NOTHING beyond the audit row —
        // no request-log entry, no dispatch.
        // Scope classification for the gate reads the FULL operations list,
        // not the surface-filtered set (a surface-hidden write op must deny
        // as insufficient_scope, not audit as a read).
        const calledOp = operations.find(o => o.name === toolName);
        const gate = await gateRemoteToolCall(
          sql,
          auth.auth,
          toolName,
          calledOp?.scope ?? 'read',
        );
        if (!gate.allow) {
          return Response.json(
            {
              result: {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    error: gate.reason === 'audit_unavailable' ? 'audit_unavailable' : 'permission_denied',
                    message: `Operation ${toolName} denied by the auth gate (${gate.reason ?? 'denied'}).`,
                    correlation_id: gate.correlationId,
                  }),
                }],
                isError: true,
              },
              jsonrpc: '2.0',
              id,
            },
            { headers: corsHeaders(origin) },
          );
        }
        const op = operationsByName[toolName];
        if (op && !op.localOnly && !hasScope(auth.auth!.scopes, op.scope ?? 'read') &&
            !(op.agentCallable === true && hasScope(auth.auth!.scopes, 'agent'))) {
          logRequest(auth.tokenName!, `tools/call:${toolName}`, 'denied_after_list', Date.now() - startedMs);
          return Response.json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text',
            text: JSON.stringify({ error: 'permission_denied', message: `Tool requires ${op.scope ?? 'read'} scope` }) }] } },
            { headers: corsHeaders(origin) });
        }
        // v0.28: thread per-token takes-holder allow-list so takes_list /
        // takes_search / query (when it returns takes) can server-side filter.
        // v0.34.1 (#861): thread source-isolation scope. Legacy access_tokens
        // path defaults to 'default' per AuthResult.sourceId above.
        // #3242: a token with NO operator-set source grant reads across the
        // federated set (config.federated sources), not just the scalar
        // 'default' floor. Granted tokens (hasSourceGrant) never widen.
        let localFederated: string[] | undefined;
        if (auth.hasSourceGrant === false && auth.sourceId) {
          try {
            const { localFederatedSourceIds } = await import('../core/source-resolver.ts');
            localFederated = await localFederatedSourceIds(engine, auth.sourceId, 'seed_default');
          } catch { /* scalar scope stands */ }
        }
        const result = await dispatchToolCall(engine, toolName, args, {
          remote: true,
          // WP1/D7: network transport — the dispatch-layer localOnly
          // backstop keys off this marker.
          transport: 'http',
          takesHoldersAllowList: auth.takesHoldersAllowList,
          sourceId: auth.sourceId,
          ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
          // #1336: thread the token's federated_read grant so read ops scope
          // to the operator-granted sources via sourceScopeOpts.
          auth: auth.auth,
          // MEMORY_VERBS v1 [c1/c2]: fail-closed surface enforcement here too.
          ...(surfaceAllowedOps ? { allowedOps: surfaceAllowedOps } : {}),
          // v132: this transport already ran gateRemoteToolCall above —
          // suppress the dispatcher's backstop so the decision isn't
          // double-audited.
          tenantGateDone: true,
          surface,
          // WP4 (D2): this transport has no per-client rows, so its surface
          // IS the ceiling request_tools bounds catalog + persist by.
          surfaceCeiling: surface,
        });
        // Same status taxonomy as the OAuth transport (denied_after_list /
        // success_with_warnings feed the amendment-33 metric + E4 usage).
        const status = requestLogStatusForResult(result);
        logRequest(auth.tokenName!, `tools/call:${toolName}`, status, Date.now() - startedMs);
        return Response.json(
          { result, jsonrpc: '2.0', id },
          { headers: corsHeaders(origin) },
        );
      }

      logRequest(auth.tokenName!, method ?? 'unknown', 'unknown_method', Date.now() - startedMs);
      return Response.json(
        { error: 'unknown_method', message: `Unknown method: ${method}` },
        { status: 400, headers: corsHeaders(origin) },
      );
    },
  });

  console.error(`GBrain HTTP MCP server running on port ${port}`);
  console.error(`  Health: http://localhost:${port}/health`);
  console.error(`  MCP:    http://localhost:${port}/mcp`);
  console.error(`  Auth:   Bearer token required (create with: gbrain auth create <name>)`);
  if (!corsAllowlist) {
    console.error('  CORS:   default-deny. Set GBRAIN_HTTP_CORS_ORIGIN=https://your.app to allow browser clients.');
  } else {
    console.error(`  CORS:   allowlist = ${[...corsAllowlist].join(', ')}`);
  }
  console.error('');
  console.error('⚠️  Do NOT use open OAuth registration for remote MCP access.');
  console.error('   Tokens are managed via: gbrain auth create/list/revoke');

  return server;
}
