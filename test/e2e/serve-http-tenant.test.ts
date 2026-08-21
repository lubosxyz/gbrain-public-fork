/**
 * E2E: tenant-scoped short-TTL tokens against the PRODUCTION OAuth HTTP
 * server (`gbrain serve --http` / runServeHttp) — the transport the fleet
 * actually runs. The transport-level unit matrix lives in
 * test/tenant-token-minting.test.ts (legacy startHttpTransport + dispatch
 * backstop); this file proves the same RED/GREEN contract holds on the
 * Express + MCP-SDK pipeline end-to-end:
 *
 *   GREEN  whoami over /mcp returns the server-derived tenant shape
 *   GREEN  tools/list works for a live tenant token
 *   RED    put_page (write) denies pre-handler with zero side effects
 *          beyond the audit row (no page, no request-log row, no
 *          last_used_at touch)
 *   RED    audit sink down → tools/call denies audit_unavailable
 *   RED    expired token → 401 before any dispatch
 *
 * Run: GBRAIN_DATABASE_URL=... bun test test/e2e/serve-http-tenant.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { mintScopedTenantToken } from '../../src/core/token-mint.ts';

const skip = !hasDatabase();
if (!skip) {
  assertSafeE2eDatabaseUrl(process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '');
}
const describeE2E = skip ? describe.skip : describe;
if (skip) {
  console.log('Skipping E2E serve-http-tenant tests (DATABASE_URL not set)');
}

const PORT = 19141; // distinct from serve-http-oauth.test.ts (19131) and prod 3131
const BASE = `http://localhost:${PORT}`;

describeE2E('serve-http tenant tokens E2E (v132 lane)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let sql: ReturnType<typeof postgres>;
  let engine: PostgresEngine;
  let tenantToken = '';
  let tenantTokenId = '';

  async function rpc(token: string, method: string, params?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    // Streamable-HTTP responses may arrive as SSE frames; unwrap `data:` lines.
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      const dataLine = text.split('\n').find(l => l.startsWith('data:'));
      if (dataLine) {
        try { body = JSON.parse(dataLine.slice(5)); } catch { body = null; }
      }
    }
    return { status: res.status, body };
  }

  /** Extract the tool-call JSON payload from a JSON-RPC tools/call response. */
  function toolPayload(body: any): any {
    const content = body?.result?.content?.[0]?.text;
    return content ? JSON.parse(content) : null;
  }

  beforeAll(async () => {
    const { spawn } = await import('child_process');
    const url = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL || '';
    sql = postgres(url, { prepare: false });

    engine = new PostgresEngine();
    await engine.connect({ database_url: url });
    await engine.initSchema();

    const minted = await mintScopedTenantToken(engine, {
      name: 'e2e-tenant-token',
      companySlug: 'acme-example',
      ttlSeconds: 1800,
      mintedBy: 'e2e-suite',
    });
    tenantToken = minted.token;
    tenantTokenId = minted.id;

    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', BASE,
    ], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
  }, 60_000);

  afterAll(async () => {
    serverProcess?.kill();
    try {
      await sql`DELETE FROM auth_audit WHERE token_id = ${tenantTokenId} OR actor IN ('e2e-suite')`;
      await sql`DELETE FROM access_tokens WHERE name LIKE 'e2e-tenant-%'`;
    } catch { /* cleanup best-effort */ }
    await sql?.end({ timeout: 5 });
    await engine?.disconnect();
  }, 20_000);

  test('GREEN: whoami over the production /mcp returns the server-derived tenant shape', async () => {
    const { status, body } = await rpc(tenantToken, 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    expect(status).toBe(200);
    const payload = toolPayload(body);
    expect(payload.transport).toBe('tenant');
    expect(payload.company_slug).toBe('acme-example');
    expect(payload.scopes).toEqual(['read']);
    // The allow decision landed in the durable audit.
    const verifies = await sql`
      SELECT 1 FROM auth_audit WHERE token_id = ${tenantTokenId} AND decision = 'verify' AND method = 'whoami'
    `;
    expect(verifies.length).toBeGreaterThanOrEqual(1);
  });

  test('GREEN: tools/list serves a live tenant token (audit up)', async () => {
    const { status, body } = await rpc(tenantToken, 'tools/list');
    expect(status).toBe(200);
    expect(Array.isArray(body?.result?.tools)).toBe(true);
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  test('RED: put_page denies pre-handler with zero side effects beyond the audit row', async () => {
    const [{ n: pagesBefore }] = await sql`SELECT count(*)::int AS n FROM pages`;
    const [{ n: logBefore }] = await sql`SELECT count(*)::int AS n FROM mcp_request_log`;
    const { status, body } = await rpc(tenantToken, 'tools/call', {
      name: 'put_page',
      arguments: { slug: 'e2e-red/never-exists', content: 'X' },
    });
    // The production /mcp tenant gate denies write ops at the JSON-RPC top
    // level (403 error envelope), before the SDK handler runs.
    expect(status).toBe(403);
    expect(body?.error?.data?.error).toBe('permission_denied');
    const [{ n: pagesAfter }] = await sql`SELECT count(*)::int AS n FROM pages`;
    const [{ n: logAfter }] = await sql`SELECT count(*)::int AS n FROM mcp_request_log`;
    expect(pagesAfter).toBe(pagesBefore);
    expect(logAfter).toBe(logBefore);
    const [tok] = await sql`SELECT last_used_at FROM access_tokens WHERE id = ${tenantTokenId}::uuid`;
    expect(tok.last_used_at).toBeNull();
    const denies = await sql`
      SELECT 1 FROM auth_audit WHERE token_id = ${tenantTokenId} AND decision = 'deny' AND method = 'put_page'
    `;
    expect(denies.length).toBeGreaterThanOrEqual(1);
  });

  test('RED fail-closed: audit sink down → tenant token gets NOTHING (initialize, tools/list, tools/call)', async () => {
    await sql`ALTER TABLE auth_audit RENAME TO auth_audit_hidden_e2e`;
    try {
      // initialize is gated at the top of /mcp — with audit down the
      // production handshake itself is denied (403), not just tool calls.
      const init = await rpc(tenantToken, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      });
      expect(init.status).toBe(403);
      expect(init.body?.error?.data?.error).toBe('audit_unavailable');

      const list = await rpc(tenantToken, 'tools/list');
      expect(list.status).toBe(403);
      expect(list.body?.error?.data?.error).toBe('audit_unavailable');

      const call = await rpc(tenantToken, 'tools/call', { name: 'whoami', arguments: {} });
      expect(call.status).toBe(403);
      expect(call.body?.error?.data?.error).toBe('audit_unavailable');
    } finally {
      await sql`ALTER TABLE auth_audit_hidden_e2e RENAME TO auth_audit`;
    }
  });

  test('RED: expired tenant token → 401 before any dispatch', async () => {
    const minted = await mintScopedTenantToken(engine, {
      name: 'e2e-tenant-expired',
      companySlug: 'acme-example',
      ttlSeconds: 600,
      mintedBy: 'e2e-suite',
    });
    await sql`UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE id = ${minted.id}::uuid`;
    const { status } = await rpc(minted.token, 'tools/call', { name: 'whoami', arguments: {} });
    expect(status).toBe(401);
    const [tok] = await sql`SELECT last_used_at FROM access_tokens WHERE id = ${minted.id}::uuid`;
    expect(tok.last_used_at).toBeNull();
  });
});
