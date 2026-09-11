/**
 * tenant-token-minting.test.ts — RED/GREEN synthetic matrix for the v132
 * tenant-remediation lane: server-derived tenant identity (whoami), scoped
 * short-TTL minting, fail-closed audit, and the shared pre-handler auth gate.
 *
 * Matrix contract (normative, from the approved SPEC):
 *  - ALLOW branches prove the audit row is durably written before/with the
 *    decision and the identity fields are server-derived.
 *  - DENY branches prove ZERO side effects beyond the audit row: no token
 *    rows inserted, no handler invoked, no data-source writes, no
 *    last_used_at touch.
 *  - Synthetic fixtures cover audit persistence failure, audit timeout, and
 *    alert-delivery failure: all three deny (never allow), fire exactly the
 *    redacted alert, and never throw past the gate.
 *
 * Unit surface: core functions + op handlers against a real PGLiteEngine
 * (full schema via initSchema). Transport-level proof (the handler is never
 * called on deny) runs over a REAL startHttpTransport server at the bottom.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine, type SqlQuery } from '../src/core/sql-query.ts';
import {
  mintScopedTenantToken,
  ScopedMintDenied,
  MAX_SCOPED_TOKEN_TTL_SECONDS,
} from '../src/core/token-mint.ts';
import {
  writeAuthAudit,
  createAuthAlertSink,
  AUTH_AUDIT_TIMEOUT_MS,
  type AuthAlertPayload,
} from '../src/core/auth-audit.ts';
import { gateRemoteToolCall, isExactReadGrant } from '../src/core/auth-gate.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { operations, OperationError } from '../src/core/operations.ts';
import type { AuthInfo, OperationContext } from '../src/core/operations.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { hashToken } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'tenant-token-minting-'));
const ENV_PINS: Record<string, string | undefined> = {
  GBRAIN_HOME: home,
  GBRAIN_MCP_FORCE_SURFACE: undefined,
};

let engine: PGLiteEngine;
let sql: SqlQuery;
let provider: GBrainOAuthProvider;
let serverUrl = '';
let serverStop: (() => void) | null = null;

const token_mint_scoped = operations.find(o => o.name === 'token_mint_scoped')!;
const token_revoke = operations.find(o => o.name === 'token_revoke')!;
const whoami = operations.find(o => o.name === 'whoami')!;

function ctxWith(overrides: Partial<OperationContext>): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

const localCtx = () => ctxWith({ remote: false });
const adminAuth = (): AuthInfo =>
  ({ token: 'x', clientId: 'admin-bootstrap', clientName: 'admin-bootstrap', scopes: ['admin'] }) as AuthInfo;

async function auditRows(where?: { decision?: string; reason?: string }): Promise<Record<string, unknown>[]> {
  const rows = await sql`SELECT * FROM auth_audit ORDER BY created_at ASC`;
  return rows.filter(
    r =>
      (where?.decision === undefined || r.decision === where.decision) &&
      (where?.reason === undefined || r.reason === where.reason),
  );
}

async function tokenCount(): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM access_tokens`;
  return Number(rows[0]?.n ?? -1);
}

beforeAll(async () => {
  await withEnv(ENV_PINS, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    sql = sqlQueryForEngine(engine);
    provider = new GBrainOAuthProvider({ sql: sql as any, tokenTtl: 60 });
    const server = await startHttpTransport({
      port: 0,
      engine,
      limiters: {
        ip: new RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 100_000, windowMs: 60_000, lruCap: 100 }),
      },
      surface: 'full',
    });
    serverUrl = `http://localhost:${(server as { port: number }).port}`;
    serverStop = () => (server as unknown as { stop: (force: boolean) => void }).stop(true);
  });
}, 120_000);

afterAll(async () => {
  serverStop?.();
  if (engine) await engine.disconnect();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// auth-audit: durable write + hard timeout + alert sink
// ---------------------------------------------------------------------------

describe('writeAuthAudit', () => {
  test('GREEN: durable row with redacted identity fields', async () => {
    const res = await writeAuthAudit(sql, {
      decision: 'verify',
      method: 'search',
      tokenId: '00000000-0000-4000-8000-000000000001',
      tokenName: 'unit-token',
      companySlug: 'acme-example',
      actor: 'unit-token',
    });
    expect(res.ok).toBe(true);
    const rows = await sql`SELECT * FROM auth_audit WHERE correlation_id = ${res.correlationId}`;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('verify');
    expect(rows[0].method).toBe('search');
    expect(rows[0].company_slug).toBe('acme-example');
    // Redaction is structural: the writer takes no token-value field at all.
    expect(Object.keys(rows[0])).not.toContain('token');
  });

  test('RED: persistence failure → ok:false + exactly the redacted alert', async () => {
    const alerts: AuthAlertPayload[] = [];
    const sink = createAuthAlertSink({ deliver: p => alerts.push(p) });
    const failingSql: SqlQuery = async () => { throw new Error('db down'); };
    const res = await writeAuthAudit(failingSql, { decision: 'verify', method: 'search' }, { alertSink: sink });
    expect(res.ok).toBe(false);
    expect(alerts.length).toBe(1);
    expect(alerts[0].reason).toBe('audit_persistence_failure');
    expect(alerts[0].method).toBe('search');
    expect(alerts[0].correlation_id).toBe(res.correlationId);
    // Redaction: the alert payload carries ONLY the four contract fields.
    expect(Object.keys(alerts[0]).sort()).toEqual(['correlation_id', 'method', 'reason', 'ts']);
  });

  test('RED: hard timeout → ok:false + audit_timeout alert (default is the 2s SPEC bound)', async () => {
    expect(AUTH_AUDIT_TIMEOUT_MS).toBe(2000);
    const alerts: AuthAlertPayload[] = [];
    const sink = createAuthAlertSink({ deliver: p => alerts.push(p) });
    const hangingSql: SqlQuery = () => new Promise(() => {}) as any;
    const res = await writeAuthAudit(hangingSql, { decision: 'verify', method: 'query' }, { alertSink: sink, timeoutMs: 50 });
    expect(res.ok).toBe(false);
    expect(alerts.length).toBe(1);
    expect(alerts[0].reason).toBe('audit_timeout');
  });

  test('RED: alert-delivery failure is swallowed (deny still stands, no throw)', async () => {
    const sink = createAuthAlertSink({ deliver: () => { throw new Error('pager down'); } });
    const failingSql: SqlQuery = async () => { throw new Error('db down'); };
    const res = await writeAuthAudit(failingSql, { decision: 'verify', method: 'search' }, { alertSink: sink });
    expect(res.ok).toBe(false);
  });

  test('REDACTION: an untrusted method/reason/slug is sanitized before it can reach the row or alert', async () => {
    // Simulate a caller sending a bearer-token-shaped value as the tool name.
    const secretish = 'gbrain_' + 'a'.repeat(64);
    const alerts: AuthAlertPayload[] = [];
    const sink = createAuthAlertSink({ deliver: p => alerts.push(p) });
    const res = await writeAuthAudit(
      sql,
      {
        decision: 'deny',
        method: secretish, // too long + contains no illegal chars but >64
        reason: 'Not A Valid Reason!!',
        companySlug: 'NOT a slug; could be pasted text',
      },
      { alertSink: sink },
    );
    expect(res.ok).toBe(true);
    const rows = await sql`SELECT method, reason, company_slug FROM auth_audit WHERE correlation_id = ${res.correlationId}`;
    expect(rows[0].method).toBe('unknown_operation'); // never the raw value
    expect(rows[0].reason).toBe('unspecified');
    // Round-2 P1: a 40-char GitHub-style token fits the OLD 64-char charset
    // regex; the tightened lowercase-snake shape must reject it too.
    const ghShaped = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const res2 = await writeAuthAudit(sql, { decision: 'deny', method: ghShaped }, { alertSink: sink });
    const rows2 = await sql`SELECT method FROM auth_audit WHERE correlation_id = ${res2.correlationId}`;
    expect(rows2[0].method).toBe('unknown_operation');
    expect(rows[0].company_slug).toBeNull();
    // The row must not contain the secret-ish string anywhere.
    expect(JSON.stringify(rows[0])).not.toContain(secretish);
  });

  test('REDACTION: a slug that IS valid format is preserved; a too-long method is dropped to constant', async () => {
    const res = await writeAuthAudit(sql, {
      decision: 'verify',
      method: 'tools/call', // valid shape → preserved
      companySlug: 'acme-example', // valid slug → preserved
    });
    const rows = await sql`SELECT method, company_slug FROM auth_audit WHERE correlation_id = ${res.correlationId}`;
    expect(rows[0].method).toBe('tools/call');
    expect(rows[0].company_slug).toBe('acme-example');
  });
});

describe('createAuthAlertSink', () => {
  test('dedups per (method, reason) within the window; rate-limits overall; bounded keys', () => {
    const delivered: AuthAlertPayload[] = [];
    let t = 1_000_000;
    const sink = createAuthAlertSink({
      deliver: p => delivered.push(p),
      dedupWindowMs: 60_000,
      maxPerWindow: 3,
      maxKeys: 4,
      now: () => t,
    });
    sink.emit({ correlationId: 'a', method: 'search', reason: 'audit_timeout' });
    sink.emit({ correlationId: 'b', method: 'search', reason: 'audit_timeout' }); // dedup
    expect(delivered.length).toBe(1);
    sink.emit({ correlationId: 'c', method: 'query', reason: 'audit_timeout' }); // new key
    sink.emit({ correlationId: 'd', method: 'query', reason: 'audit_persistence_failure' }); // new key
    expect(delivered.length).toBe(3);
    sink.emit({ correlationId: 'e', method: 'get_page', reason: 'audit_timeout' }); // over maxPerWindow
    expect(delivered.length).toBe(3);
    // Next window: dedup + rate limit reset.
    t += 61_000;
    sink.emit({ correlationId: 'f', method: 'search', reason: 'audit_timeout' });
    expect(delivered.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// mintScopedTenantToken: pre-insert validation matrix (deny = zero rows)
// ---------------------------------------------------------------------------

describe('mintScopedTenantToken', () => {
  test('GREEN: mints exactly-[read], <=60min server-time expiry, tenant + minter stored', async () => {
    const before = Date.now();
    const minted = await mintScopedTenantToken(engine, {
      name: 'mint-green',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    expect(minted.scopes).toEqual(['read']);
    expect(minted.companySlug).toBe('acme-example');
    const rows = await sql`SELECT * FROM access_tokens WHERE id = ${minted.id}::uuid`;
    expect(rows.length).toBe(1);
    expect(rows[0].company_slug).toBe('acme-example');
    expect(rows[0].minted_by).toBe('unit-suite');
    // The plaintext is never stored — only its hash.
    expect(rows[0].token_hash).toBe(hashToken(minted.token));
    const expMs = new Date(minted.expiresAt).getTime();
    expect(expMs).toBeGreaterThan(before);
    expect(expMs).toBeLessThanOrEqual(before + (600 + 120) * 1000);
  });

  test('DB CHECK: all-or-none tenant metadata is structurally enforced (both directions)', async () => {
    // slug without expiry — forbidden.
    await expect(
      sql`INSERT INTO access_tokens (name, token_hash, scopes, company_slug)
          VALUES ('chk-slug-only', ${hashToken('chk-slug-only')}, ${'{read}'}::text[], 'acme-example')`,
    ).rejects.toBeDefined();
    // expiry without slug — forbidden (the reverse direction R2 missed).
    await expect(
      sql`INSERT INTO access_tokens (name, token_hash, scopes, expires_at, minted_by)
          VALUES ('chk-exp-only', ${hashToken('chk-exp-only')}, ${'{read}'}::text[], now() + interval '10 min', 'x')`,
    ).rejects.toBeDefined();
    // slug with non-read scopes — forbidden.
    await expect(
      sql`INSERT INTO access_tokens (name, token_hash, scopes, company_slug, expires_at, minted_by)
          VALUES ('chk-slug-write', ${hashToken('chk-slug-write')}, ${'{read,write}'}::text[], 'acme-example', now() + interval '10 min', 'x')`,
    ).rejects.toBeDefined();
    // A fully-formed tenant row is accepted.
    const ok = await sql`
      INSERT INTO access_tokens (name, token_hash, scopes, company_slug, expires_at, minted_by)
      VALUES ('chk-ok', ${hashToken('chk-ok-value')}, ${'{read}'}::text[], 'acme-example', now() + interval '10 min', 'suite')
      RETURNING id`;
    expect(ok.length).toBe(1);
  });

  const denyCases: Array<{ label: string; opts: Record<string, unknown>; reason: string }> = [
    { label: 'ttl over the 60min cap', opts: { ttlSeconds: MAX_SCOPED_TOKEN_TTL_SECONDS + 1 }, reason: 'ttl_exceeded' },
    { label: 'ttl zero', opts: { ttlSeconds: 0 }, reason: 'ttl_exceeded' },
    { label: 'ttl non-integer', opts: { ttlSeconds: 1.5 }, reason: 'ttl_exceeded' },
    { label: 'scopes wider than [read]', opts: { requestedScopes: ['read', 'write'] }, reason: 'invalid_scope_request' },
    { label: 'scopes = [write]', opts: { requestedScopes: ['write'] }, reason: 'invalid_scope_request' },
    { label: 'scopes = [admin]', opts: { requestedScopes: ['admin'] }, reason: 'invalid_scope_request' },
    { label: 'scopes empty', opts: { requestedScopes: [] }, reason: 'invalid_scope_request' },
    { label: 'uppercase slug', opts: { companySlug: 'Acme' }, reason: 'invalid_company_slug' },
    { label: 'empty slug', opts: { companySlug: '' }, reason: 'invalid_company_slug' },
    { label: 'overlong slug', opts: { companySlug: 'x'.repeat(70) }, reason: 'invalid_company_slug' },
    { label: 'empty name', opts: { name: '  ' }, reason: 'invalid_name' },
    { label: 'OAuth-prefix name (whoami masquerade)', opts: { name: 'gbrain_cl_sneaky' }, reason: 'invalid_name' },
  ];

  for (const c of denyCases) {
    test(`RED: ${c.label} → ${c.reason}, ZERO rows written`, async () => {
      const before = await tokenCount();
      const attempt = mintScopedTenantToken(engine, {
        name: 'deny-case',
        companySlug: 'acme-example',
        mintedBy: 'unit-suite',
        ...(c.opts as any),
      });
      await expect(attempt).rejects.toBeInstanceOf(ScopedMintDenied);
      await attempt.catch(e => expect((e as ScopedMintDenied).reason).toBe(c.reason));
      expect(await tokenCount()).toBe(before);
    });
  }
});

// ---------------------------------------------------------------------------
// token_mint_scoped / token_revoke op handlers (principal allowlist + audit)
// ---------------------------------------------------------------------------

describe('token_mint_scoped op', () => {
  test('GREEN: local operator mints; audit decision=mint written', async () => {
    const result = (await token_mint_scoped.handler(localCtx(), {
      name: 'op-local-mint',
      company_slug: 'acme-example',
      ttl_seconds: 300,
    })) as any;
    expect(typeof result.token).toBe('string');
    expect(result.company_slug).toBe('acme-example');
    expect(result.scopes).toEqual(['read']);
    const rows = await sql`SELECT * FROM auth_audit WHERE correlation_id = ${result.correlation_id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('mint');
    expect(rows[0].token_id).toBe(result.id);
    expect(rows[0].actor).toBe('local_operator');
  });

  test('GREEN: remote admin principal mints; actor is the admin identity', async () => {
    const result = (await token_mint_scoped.handler(
      ctxWith({ remote: true, auth: adminAuth() }),
      { name: 'op-admin-mint', company_slug: 'acme-example' },
    )) as any;
    const rows = await sql`SELECT * FROM auth_audit WHERE correlation_id = ${result.correlation_id}`;
    expect(rows[0].actor).toBe('admin-bootstrap');
  });

  test('RED: non-admin remote principal → permission_denied, deny audited, zero rows', async () => {
    const before = await tokenCount();
    const attempt = token_mint_scoped.handler(
      ctxWith({ remote: true, auth: { ...adminAuth(), scopes: ['write'] } as AuthInfo }),
      { name: 'op-deny-mint', company_slug: 'acme-example' },
    );
    await expect(attempt).rejects.toBeInstanceOf(OperationError);
    expect(await tokenCount()).toBe(before);
    const denies = await auditRows({ decision: 'deny', reason: 'mint_principal_denied' });
    expect(denies.length).toBeGreaterThanOrEqual(1);
  });

  test('RED: a tenant-scoped token can NEVER mint, even with tampered admin scopes', async () => {
    const before = await tokenCount();
    const attempt = token_mint_scoped.handler(
      ctxWith({
        remote: true,
        auth: { ...adminAuth(), scopes: ['admin'], tenantScoped: true } as AuthInfo,
      }),
      { name: 'op-tenant-mint', company_slug: 'acme-example' },
    );
    await expect(attempt).rejects.toBeInstanceOf(OperationError);
    expect(await tokenCount()).toBe(before);
  });

  test('RED: unauthenticated remote (stdio-shaped) → denied', async () => {
    const attempt = token_mint_scoped.handler(
      ctxWith({ remote: true, transport: 'stdio' }),
      { name: 'op-stdio-mint', company_slug: 'acme-example' },
    );
    await expect(attempt).rejects.toBeInstanceOf(OperationError);
  });

  test('RED: ttl over cap through the op → invalid_params + audited deny, zero rows', async () => {
    const before = await tokenCount();
    const attempt = token_mint_scoped.handler(localCtx(), {
      name: 'op-ttl-mint',
      company_slug: 'acme-example',
      ttl_seconds: 3601,
    });
    await expect(attempt).rejects.toBeInstanceOf(OperationError);
    expect(await tokenCount()).toBe(before);
    const denies = await auditRows({ decision: 'deny', reason: 'ttl_exceeded' });
    expect(denies.length).toBeGreaterThanOrEqual(1);
  });

  test('RED fail-closed: audit unavailable → mint rolled back, token NOT issued', async () => {
    // Synthetic fixture: make the audit sink unwritable, then restore.
    await engine.executeRaw('ALTER TABLE auth_audit RENAME TO auth_audit_hidden');
    try {
      const before = await tokenCount();
      const attempt = token_mint_scoped.handler(localCtx(), {
        name: 'op-failclosed-mint',
        company_slug: 'acme-example',
      });
      await expect(attempt).rejects.toBeInstanceOf(OperationError);
      // The row was inserted then revoked (fail-closed rollback): it must not
      // remain usable. Either shape is acceptable — absent or revoked.
      const rows = await sql`
        SELECT revoked_at FROM access_tokens WHERE name = ${'op-failclosed-mint'}
      `;
      for (const r of rows) expect(r.revoked_at).not.toBeNull();
      expect((await tokenCount()) - before).toBeLessThanOrEqual(1);
    } finally {
      await engine.executeRaw('ALTER TABLE auth_audit_hidden RENAME TO auth_audit');
    }
  });
});

describe('round-2 P2 — dry run performs no writes', () => {
  test('token_mint_scoped honors ctx.dryRun: preview only, nothing minted, nothing audited', async () => {
    const before = (await sql`SELECT count(*)::int AS n FROM access_tokens`)[0].n;
    const result = (await token_mint_scoped.handler(
      { ...localCtx(), dryRun: true },
      { name: 'dry-mint', company_slug: 'acme-example' },
    )) as any;
    expect(result.dry_run).toBe(true);
    expect(result.token).toBeUndefined();
    const after = (await sql`SELECT count(*)::int AS n FROM access_tokens`)[0].n;
    expect(after).toBe(before);
  });

  test('token_revoke honors ctx.dryRun: the token stays valid', async () => {
    const minted = (await token_mint_scoped.handler(localCtx(), {
      name: 'dry-revoke-target',
      company_slug: 'acme-example',
    })) as any;
    const result = (await token_revoke.handler(
      { ...localCtx(), dryRun: true },
      { id: minted.id },
    )) as any;
    expect(result.dry_run).toBe(true);
    const rows = await sql`SELECT revoked_at FROM access_tokens WHERE id = ${minted.id}::uuid`;
    expect(rows[0].revoked_at).toBeNull();
  });
});

describe('token_revoke op', () => {
  test('GREEN: revoke by id → next verification denies; audit decision=revoke', async () => {
    const minted = (await token_mint_scoped.handler(localCtx(), {
      name: 'op-revoke-target',
      company_slug: 'acme-example',
    })) as any;
    const result = (await token_revoke.handler(localCtx(), { id: minted.id })) as any;
    expect(result.revoked).toBe(true);
    expect(result.audit_ok).toBe(true);
    const rows = await sql`
      SELECT * FROM auth_audit WHERE correlation_id = ${result.correlation_id}
    `;
    expect(rows[0].decision).toBe('revoke');
    expect(rows[0].token_id).toBe(minted.id);
    await expect(provider.verifyAccessToken(minted.token)).rejects.toBeInstanceOf(InvalidTokenError);
    // The revocation deny itself is audited with identity (token_revoked).
    const denies = await auditRows({ decision: 'deny', reason: 'token_revoked' });
    expect(denies.some(d => d.token_id === minted.id)).toBe(true);
  });

  test('RED: non-admin remote principal cannot revoke', async () => {
    const attempt = token_revoke.handler(
      ctxWith({ remote: true, auth: { ...adminAuth(), scopes: ['read'] } as AuthInfo }),
      { id: '00000000-0000-4000-8000-000000000002' },
    );
    await expect(attempt).rejects.toBeInstanceOf(OperationError);
  });
});

// ---------------------------------------------------------------------------
// verifyAccessToken: tenant threading + expiry + grandfathering
// ---------------------------------------------------------------------------

describe('verifyAccessToken (legacy table, v132 lane)', () => {
  test('GREEN: minted token verifies with server-derived tenant + real expiry + exact [read]', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'verify-green',
      companySlug: 'acme-example',
      ttlSeconds: 900,
      mintedBy: 'unit-suite',
    });
    const info = (await provider.verifyAccessToken(minted.token)) as any;
    expect(info.companySlug).toBe('acme-example');
    expect(info.tenantScoped).toBe(true);
    expect(info.scopes).toEqual(['read']);
    expect(info.tokenId).toBe(minted.id);
    const now = Math.floor(Date.now() / 1000);
    expect(info.expiresAt).toBeGreaterThan(now);
    expect(info.expiresAt).toBeLessThanOrEqual(now + 900 + 120);
  });

  test('RED: expired token → InvalidTokenError, audited, NO last_used_at touch', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'verify-expired',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    await sql`UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE id = ${minted.id}::uuid`;
    await expect(provider.verifyAccessToken(minted.token)).rejects.toBeInstanceOf(InvalidTokenError);
    const rows = await sql`SELECT last_used_at FROM access_tokens WHERE id = ${minted.id}::uuid`;
    expect(rows[0].last_used_at).toBeNull();
    const denies = await auditRows({ decision: 'deny', reason: 'token_expired' });
    expect(denies.some(d => d.token_id === minted.id)).toBe(true);
  });

  test('GREEN back-compat: grandfathered token (no tenant metadata) is unchanged', async () => {
    const raw = 'grandfathered-token-value-1';
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)`,
      ['grandfathered-1', hashToken(raw)],
    );
    const info = (await provider.verifyAccessToken(raw)) as any;
    expect(info.companySlug).toBeUndefined();
    expect(info.tenantScoped).toBeUndefined();
    expect(info.scopes).toEqual(['read', 'write', 'admin']);
    // Historical synthetic ~1yr expiry survives.
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 300 * 24 * 3600);
  });

  test('RED: unknown token → InvalidTokenError with no new audit rows (no identity to record)', async () => {
    const before = (await auditRows()).length;
    await expect(provider.verifyAccessToken('no-such-token')).rejects.toBeInstanceOf(InvalidTokenError);
    expect((await auditRows()).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// whoami: server-derived tenant shape vs the legacy marker
// ---------------------------------------------------------------------------

describe('whoami tenant shape', () => {
  test('tenant-scoped token → transport tenant with server-verified company_slug', async () => {
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        auth: {
          token: 'x',
          clientId: 'tenant-token',
          clientName: 'tenant-token',
          scopes: ['read'],
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          companySlug: 'acme-example',
          tenantScoped: true,
          sourceId: 'default',
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('tenant');
    expect(result.company_slug).toBe('acme-example');
    expect(result.scopes).toEqual(['read']);
    expect(typeof result.expires_at).toBe('number');
  });

  test('tenant branch wins over the OAuth clientId-prefix heuristic (masquerade defense)', async () => {
    // Even if a token row somehow carried an OAuth-prefixed NAME, the
    // server-stored company_slug decides the shape — the caller-chosen name
    // must never reclassify a tenant token as an OAuth client.
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        auth: {
          token: 'x',
          clientId: 'gbrain_cl_masquerade',
          clientName: 'gbrain_cl_masquerade',
          scopes: ['read'],
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          companySlug: 'acme-example',
          tenantScoped: true,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('tenant');
    expect(result.company_slug).toBe('acme-example');
  });

  test('grandfathered token → transport legacy, NEVER a fabricated slug', async () => {
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        auth: { token: 'x', clientId: 'old-token', clientName: 'old-token', scopes: ['read', 'write', 'admin'] } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('legacy');
    expect(result.company_slug).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// gateRemoteToolCall: the shared pre-handler resolver
// ---------------------------------------------------------------------------

describe('gateRemoteToolCall (server-authoritative row re-check)', () => {
  async function mintGateToken(name: string) {
    const minted = await mintScopedTenantToken(engine, {
      name,
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'gate-suite',
    });
    const auth: AuthInfo = {
      token: minted.token,
      clientId: minted.name,
      clientName: minted.name,
      scopes: ['read'],
      expiresAt: Math.floor(new Date(minted.expiresAt).getTime() / 1000),
      companySlug: 'acme-example',
      tokenId: minted.id,
      tenantScoped: true,
    } as AuthInfo;
    return { minted, auth };
  }

  /** sql wrapper: real engine for reads, injected behavior for auth_audit INSERTs. */
  function sqlWithAuditBehavior(onAuditInsert: () => Promise<Record<string, unknown>[]>): SqlQuery {
    return ((strings: TemplateStringsArray, ...values: any[]) => {
      const text = strings.join(' ');
      if (/INSERT INTO auth_audit/i.test(text)) return onAuditInsert();
      return (sql as any)(strings, ...values);
    }) as SqlQuery;
  }

  test('no-op for grandfathered/OAuth callers (no audit row)', async () => {
    const before = (await auditRows()).length;
    const res = await gateRemoteToolCall(
      sql,
      { token: 'x', clientId: 'old', clientName: 'old', scopes: ['read', 'write', 'admin'] } as AuthInfo,
      'search',
      'read',
    );
    expect(res.allow).toBe(true);
    expect((await auditRows()).length).toBe(before);
  });

  test('GREEN: tenant + read op → allow, audit verify row durably written', async () => {
    const { auth } = await mintGateToken('gate-green');
    const res = await gateRemoteToolCall(sql, auth, 'search', 'read');
    expect(res.allow).toBe(true);
    const rows = await sql`SELECT * FROM auth_audit WHERE correlation_id = ${res.correlationId!}`;
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe('verify');
    expect(rows[0].method).toBe('search');
    expect(rows[0].company_slug).toBe('acme-example');
  });

  test('RED: tenant + write op → deny insufficient_scope, audited', async () => {
    const { auth } = await mintGateToken('gate-write-deny');
    const res = await gateRemoteToolCall(sql, auth, 'put_page', 'write');
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('insufficient_scope');
    const rows = await sql`SELECT * FROM auth_audit WHERE correlation_id = ${res.correlationId!}`;
    expect(rows[0].decision).toBe('deny');
  });

  test('RED: tenant + admin op → deny insufficient_scope', async () => {
    const { auth } = await mintGateToken('gate-admin-deny');
    const res = await gateRemoteToolCall(sql, auth, 'token_mint_scoped', 'admin');
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('insufficient_scope');
  });

  test('RED: row expired since verification (server-time re-check) → deny token_expired', async () => {
    const { minted, auth } = await mintGateToken('gate-expired');
    await sql`UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE id = ${minted.id}::uuid`;
    // AuthInfo still says "valid for 10 minutes" — the ROW decides.
    const res = await gateRemoteToolCall(sql, auth, 'search', 'read');
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('token_expired');
  });

  test('RED TOCTOU: row revoked after verification → deny token_revoked', async () => {
    const { minted, auth } = await mintGateToken('gate-revoked');
    await sql`UPDATE access_tokens SET revoked_at = now() WHERE id = ${minted.id}::uuid`;
    const res = await gateRemoteToolCall(sql, auth, 'search', 'read');
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('token_revoked');
  });

  test('RED: token row deleted → deny token_unknown; malformed/missing id → deny token_lookup_failed', async () => {
    const { minted, auth } = await mintGateToken('gate-deleted');
    await sql`DELETE FROM access_tokens WHERE id = ${minted.id}::uuid`;
    const res = await gateRemoteToolCall(sql, auth, 'search', 'read');
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('token_unknown');

    const noId = await gateRemoteToolCall(sql, { ...auth, tokenId: undefined } as AuthInfo, 'search', 'read');
    expect(noId.allow).toBe(false);
    expect(noId.reason).toBe('token_lookup_failed');
  });

  test('the widened-grant tamper state is now DB-UNREPRESENTABLE (CHECK), and isExactReadGrant is the app belt', async () => {
    // Post-R3 the all-or-none + read-only CHECK constraints make a
    // slug-bearing non-read row impossible to insert, so the gate's
    // invalid_scope_grant path is a belt over a structural guarantee. Prove
    // the row can't be created, and keep the app-level predicate pinned.
    await expect(
      sql`INSERT INTO access_tokens (name, token_hash, scopes, company_slug, expires_at, minted_by)
          VALUES ('gate-widened', ${hashToken('gate-widened-value')}, ${'{read,write}'}::text[],
                  'acme-example', now() + interval '10 minutes', 'suite')`,
    ).rejects.toBeDefined();
    expect(isExactReadGrant(['read'])).toBe(true);
    expect(isExactReadGrant(['read', 'write'])).toBe(false);
    expect(isExactReadGrant([])).toBe(false);
    expect(isExactReadGrant(undefined)).toBe(false);
  });

  test('RED fail-closed: audit persistence failure turns ALLOW into DENY + alert', async () => {
    const { auth } = await mintGateToken('gate-audit-fail');
    const alerts: AuthAlertPayload[] = [];
    const sink = createAuthAlertSink({ deliver: p => alerts.push(p) });
    const failingAuditSql = sqlWithAuditBehavior(async () => { throw new Error('db down'); });
    const res = await gateRemoteToolCall(failingAuditSql, auth, 'search', 'read', { alertSink: sink });
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('audit_unavailable');
    expect(alerts.length).toBe(1);
    expect(alerts[0].reason).toBe('audit_persistence_failure');
  });

  test('RED fail-closed: audit timeout turns ALLOW into DENY + alert', async () => {
    const { auth } = await mintGateToken('gate-audit-hang');
    const alerts: AuthAlertPayload[] = [];
    const sink = createAuthAlertSink({ deliver: p => alerts.push(p) });
    const hangingAuditSql = sqlWithAuditBehavior(() => new Promise(() => {}) as any);
    const res = await gateRemoteToolCall(hangingAuditSql, auth, 'search', 'read', {
      alertSink: sink,
      timeoutMs: 50,
    });
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('audit_unavailable');
    expect(alerts[0].reason).toBe('audit_timeout');
  });

  test('RED: alert-delivery failure still denies and never throws', async () => {
    const { auth } = await mintGateToken('gate-alert-fail');
    const sink = createAuthAlertSink({ deliver: () => { throw new Error('pager down'); } });
    const failingAuditSql = sqlWithAuditBehavior(async () => { throw new Error('db down'); });
    const res = await gateRemoteToolCall(failingAuditSql, auth, 'search', 'read', { alertSink: sink });
    expect(res.allow).toBe(false);
  });

  test('RED: total DB outage denies (row lookup fails before any audit attempt)', async () => {
    const { auth } = await mintGateToken('gate-db-down');
    const downSql: SqlQuery = async () => { throw new Error('db down'); };
    const res = await gateRemoteToolCall(downSql, auth, 'search', 'read');
    expect(res.allow).toBe(false);
    expect(res.reason).toBe('token_lookup_failed');
  });
});

// ---------------------------------------------------------------------------
// dispatchToolCall backstop: an internal/future caller that skips the
// transport gate is still gated at the shared dispatcher.
// ---------------------------------------------------------------------------

describe('dispatchToolCall tenant backstop', () => {
  test('RED: ungated tenant write dispatch → denied at the dispatcher, audited, zero pages', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'backstop-write',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    const auth: AuthInfo = {
      token: minted.token,
      clientId: minted.name,
      clientName: minted.name,
      scopes: ['read'],
      expiresAt: Math.floor(new Date(minted.expiresAt).getTime() / 1000),
      companySlug: 'acme-example',
      tokenId: minted.id,
      tenantScoped: true,
    } as AuthInfo;
    const pagesBefore = Number((await sql`SELECT count(*)::int AS n FROM pages`)[0].n);
    const result = await dispatchToolCall(engine, 'put_page', { slug: 'red/backstop-never', content: 'X' }, {
      remote: true,
      transport: 'http',
      sourceId: 'default',
      auth,
      // deliberately NO tenantGateDone — simulating a caller that forgot
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.error).toBe('permission_denied');
    expect(Number((await sql`SELECT count(*)::int AS n FROM pages`)[0].n)).toBe(pagesBefore);
    const rows = await sql`SELECT * FROM auth_audit WHERE correlation_id = ${payload.correlation_id}`;
    expect(rows[0].decision).toBe('deny');
    expect(rows[0].method).toBe('put_page');
  });

  test('GREEN: ungated tenant read dispatch → gated allow with audit, handler runs', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'backstop-read',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    const auth: AuthInfo = {
      token: minted.token,
      clientId: minted.name,
      clientName: minted.name,
      scopes: ['read'],
      expiresAt: Math.floor(new Date(minted.expiresAt).getTime() / 1000),
      companySlug: 'acme-example',
      tokenId: minted.id,
      tenantScoped: true,
    } as AuthInfo;
    const auditBefore = (await auditRows({ decision: 'verify' })).length;
    const result = await dispatchToolCall(engine, 'whoami', {}, {
      remote: true,
      transport: 'http',
      sourceId: 'default',
      auth,
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.transport).toBe('tenant');
    expect(payload.company_slug).toBe('acme-example');
    expect((await auditRows({ decision: 'verify' })).length).toBe(auditBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Transport-level RED/GREEN over a REAL HTTP server: the handler is never
// invoked on deny (zero data-source side effects).
// ---------------------------------------------------------------------------

describe('HTTP transport end-to-end', () => {
  async function rpc(token: string, method: string, params?: unknown): Promise<any> {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  test('GREEN: tenant token calls whoami over HTTP → server-derived tenant shape', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'http-green',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    const { status, body } = await rpc(minted.token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(status).toBe(200);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.transport).toBe('tenant');
    expect(payload.company_slug).toBe('acme-example');
  });

  test('RED: tenant token write attempt (put_page) → pre-handler deny with ZERO side effects beyond audit', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'http-write-deny',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    const pagesBefore = Number((await sql`SELECT count(*)::int AS n FROM pages`)[0].n);
    const reqLogBefore = Number((await sql`SELECT count(*)::int AS n FROM mcp_request_log`)[0].n);
    const { status, body } = await rpc(minted.token, 'tools/call', {
      name: 'put_page',
      arguments: { slug: 'red/should-never-exist', content: 'X' },
    });
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.error).toBe('permission_denied');
    // Zero side effects beyond the audit row: no page, no request-log row,
    // no last_used_at touch.
    expect(Number((await sql`SELECT count(*)::int AS n FROM pages`)[0].n)).toBe(pagesBefore);
    expect(Number((await sql`SELECT count(*)::int AS n FROM mcp_request_log`)[0].n)).toBe(reqLogBefore);
    const rows = await sql`SELECT last_used_at FROM access_tokens WHERE id = ${minted.id}::uuid`;
    expect(rows[0].last_used_at).toBeNull();
    const denies = await auditRows({ decision: 'deny', reason: 'insufficient_scope' });
    expect(denies.some(d => d.method === 'put_page')).toBe(true);
  });

  test('RED: expired tenant token over HTTP → 401 before any dispatch, audited, no last_used_at touch', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'http-expired',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    await sql`UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE id = ${minted.id}::uuid`;
    const { status } = await rpc(minted.token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(status).toBe(401);
    const denies = await auditRows({ decision: 'deny', reason: 'token_expired' });
    expect(denies.some(d => d.token_id === minted.id)).toBe(true);
    const rows = await sql`SELECT last_used_at FROM access_tokens WHERE id = ${minted.id}::uuid`;
    expect(rows[0].last_used_at).toBeNull();
  });

  test('RED fail-closed over HTTP: audit sink down → tenant token gets NOTHING (initialize, tools/list, tools/call)', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'http-audit-down',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'unit-suite',
    });
    await engine.executeRaw('ALTER TABLE auth_audit RENAME TO auth_audit_hidden');
    try {
      for (const [method, params] of [
        ['initialize', undefined],
        ['tools/list', undefined],
        ['tools/call', { name: 'whoami', arguments: {} }],
      ] as const) {
        const { status, body } = await rpc(minted.token, method, params);
        if (method === 'tools/call') {
          expect(status).toBe(200);
          expect(body.result.isError).toBe(true);
          expect(JSON.parse(body.result.content[0].text).error).toBe('audit_unavailable');
        } else {
          expect(status).toBe(403);
          expect(body.error).toBe('audit_unavailable');
        }
      }
    } finally {
      await engine.executeRaw('ALTER TABLE auth_audit_hidden RENAME TO auth_audit');
    }
  });

  test('GREEN back-compat: grandfathered token still calls whoami with the legacy marker', async () => {
    const raw = 'grandfathered-token-value-2';
    await engine.executeRaw(
      `INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)`,
      ['grandfathered-2', hashToken(raw)],
    );
    const { status, body } = await rpc(raw, 'tools/call', { name: 'whoami', arguments: {} });
    expect(status).toBe(200);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.transport).toBe('legacy');
    expect(payload.company_slug).toBeUndefined();
  });
});
