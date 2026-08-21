/**
 * Tenant-scoped token lifecycle ops (v132 tenant-remediation lane):
 * `token_mint_scoped` + `token_revoke`. Contract-first like every op —
 * the CLI command and MCP tool are both generated from these definitions.
 *
 * Trust model:
 *  - Minting principal allowlist = the `admin` scope tier (an admin
 *    bootstrap token or an operator-registered privileged token) or the
 *    trusted local CLI (`ctx.remote === false`). The op declares
 *    `scope: 'admin'`, so remote dispatch scope-gates it before the handler;
 *    the handler re-asserts (defense in depth for non-HTTP dispatch paths)
 *    and additionally refuses tenant-scoped tokens outright — a minted
 *    read-only token must never mint (privilege escalation loop).
 *  - The minted grant is exactly ['read'] with a <= 60 minute DB-computed
 *    (server-time) expiry; every non-exact request is denied BEFORE any row
 *    is written (see mintScopedTenantToken).
 *  - Every decision is audited through src/core/auth-audit.ts. The mint
 *    ALLOW is fail-closed: if the audit row cannot be durably written within
 *    the hard timeout, the just-minted row is revoked and the op fails —
 *    an unaudited credential never leaves the server.
 *  - The plaintext token appears ONCE, in this op's return value, for the
 *    authenticated minting principal. It is never logged (mcp_request_log
 *    stores only redacted param summaries) and never stored (SHA-256 hash
 *    only).
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { hasScope } from '../scope.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { writeAuthAudit } from '../auth-audit.ts';
import {
  mintScopedTenantToken,
  revokeLegacyTokenById,
  ScopedMintDenied,
  MAX_SCOPED_TOKEN_TTL_SECONDS,
  TOKEN_ID_RE,
} from '../token-mint.ts';
import { assertValidSourceId } from '../source-id.ts';

/**
 * Allowlisted minting/revoking principal: trusted local CLI, or a remote
 * caller whose verified grant satisfies the `admin` tier and is NOT itself
 * a tenant-scoped minted token.
 */
function mintingPrincipal(ctx: {
  remote: boolean;
  auth?: { scopes: string[]; clientId: string; clientName?: string; tenantScoped?: boolean };
}): { allowed: boolean; actor: string } {
  if (ctx.remote === false) return { allowed: true, actor: 'local_operator' };
  if (!ctx.auth) return { allowed: false, actor: 'unauthenticated' };
  const actor = ctx.auth.clientName ?? ctx.auth.clientId;
  if (ctx.auth.tenantScoped === true) return { allowed: false, actor };
  return { allowed: hasScope(ctx.auth.scopes, 'admin'), actor };
}

const token_mint_scoped: Operation = {
  name: 'token_mint_scoped',
  description:
    'Mint a tenant-scoped short-TTL READ-ONLY bearer token bound to a server-stored ' +
    'company_slug. Allowlisted minting principals only (admin scope or local CLI). ' +
    'The grant is exactly ["read"] and ttl_seconds is hard-capped at 3600 (60 minutes) — ' +
    'any other scope request or larger TTL is denied before any row is written. ' +
    'Expiry is computed from SERVER time in the database. The decision is written to the ' +
    'durable redacted auth audit; if the audit write fails, the mint is rolled back and ' +
    'the op fails (fail-closed — an unaudited credential never leaves the server). ' +
    'The plaintext token is returned ONCE and never stored or logged; wire it immediately.',
  params: {
    name: { type: 'string', required: true, description: 'Token display name (audit identity; not unique).' },
    company_slug: {
      type: 'string',
      required: true,
      description:
        'Tenant identity stored server-side on the token row ([a-z0-9-], max 63 chars). ' +
        'whoami reports it back as the server-verified tenant.',
    },
    ttl_seconds: {
      type: 'number',
      description: `Expiry in seconds from server now(). Integer 1..${MAX_SCOPED_TOKEN_TTL_SECONDS}; default ${MAX_SCOPED_TOKEN_TTL_SECONDS}. Larger values are DENIED, not clamped.`,
    },
    scopes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional; must be exactly ["read"] when provided. Anything else is denied.',
    },
    source_id: {
      type: 'string',
      description: 'Optional source grant (permissions.source_id) for the minted token.',
    },
  },
  mutating: true,
  scope: 'admin',
  annotations: { title: 'Mint tenant-scoped token', readOnlyHint: false, destructiveHint: false },
  cliHints: { name: 'token-mint-scoped', positional: ['name', 'company_slug'] },
  handler: async (ctx, p) => {
    const sql = sqlQueryForEngine(ctx.engine);
    const method = 'token_mint_scoped';
    const companySlug = typeof p.company_slug === 'string' ? p.company_slug : undefined;
    const principal = mintingPrincipal(ctx);
    if (!principal.allowed) {
      // Deny performs no writes beyond the audit row (best-effort — deny is
      // the safe direction; a failed write still fires the redacted alert).
      await writeAuthAudit(sql, {
        decision: 'deny',
        method,
        reason: 'mint_principal_denied',
        companySlug,
        actor: principal.actor,
      });
      throw new OperationError(
        'permission_denied',
        'token_mint_scoped requires an allowlisted minting principal (admin scope or local CLI).',
      );
    }

    if (p.source_id !== undefined) {
      try {
        assertValidSourceId(String(p.source_id));
      } catch (e) {
        await writeAuthAudit(sql, {
          decision: 'deny',
          method,
          reason: 'invalid_source_grant',
          companySlug,
          actor: principal.actor,
        });
        // Static message — the submitted value is untrusted input and the
        // transport error path persists this message into logs.
        void e;
        throw new OperationError('invalid_params', 'invalid source_id (submitted value withheld; see gbrain sources list for valid ids)');
      }
    }

    let minted: Awaited<ReturnType<typeof mintScopedTenantToken>>;
    try {
      minted = await mintScopedTenantToken(ctx.engine, {
        name: String(p.name ?? ''),
        companySlug: companySlug ?? '',
        ...(p.ttl_seconds !== undefined ? { ttlSeconds: Number(p.ttl_seconds) } : {}),
        ...(p.scopes !== undefined ? { requestedScopes: p.scopes as string[] } : {}),
        ...(p.source_id !== undefined ? { sourceGrant: [String(p.source_id)] } : {}),
        mintedBy: principal.actor,
      });
    } catch (e) {
      if (e instanceof ScopedMintDenied) {
        await writeAuthAudit(sql, {
          decision: 'deny',
          method,
          reason: e.reason,
          companySlug,
          actor: principal.actor,
        });
        throw new OperationError(
          e.reason === 'schema_out_of_date' ? 'unavailable' : 'invalid_params',
          e.message,
          e.reason === 'schema_out_of_date' ? 'Run gbrain apply-migrations on the brain host, then retry.' : undefined,
        );
      }
      throw e;
    }

    // Fail-closed mint audit: the credential is valid only once its audit
    // row is durably written. On failure, revoke the row and fail the op.
    const audit = await writeAuthAudit(sql, {
      decision: 'mint',
      method,
      tokenId: minted.id,
      tokenName: minted.name,
      companySlug: minted.companySlug,
      actor: principal.actor,
    });
    if (!audit.ok) {
      try {
        await revokeLegacyTokenById(sql, minted.id);
      } catch {
        /* revocation is best-effort here; the token is never returned. */
      }
      throw new OperationError(
        'unavailable',
        'auth audit is unavailable; the minted token was revoked and not issued (fail-closed).',
        'Restore auth_audit writability (run gbrain apply-migrations / check the database), then retry.',
      );
    }

    return {
      token: minted.token,
      id: minted.id,
      name: minted.name,
      company_slug: minted.companySlug,
      scopes: minted.scopes,
      expires_at: minted.expiresAt,
      correlation_id: audit.correlationId,
      notice: 'Shown once — wire it now. The server stores only a hash.',
    };
  },
};

const token_revoke: Operation = {
  name: 'token_revoke',
  description:
    'Revoke exactly one bearer token by its row id (UUID — the only safe revocation key; ' +
    'names are not unique). Allowlisted principals only (admin scope or local CLI). ' +
    'Revocation takes effect on the next verification. The decision is written to the ' +
    'durable redacted auth audit; because revocation only narrows access, an audit-write ' +
    'failure alerts but never un-revokes (`audit_ok: false` in the result).',
  params: {
    id: { type: 'string', required: true, description: 'access_tokens.id (UUID) to revoke.' },
  },
  mutating: true,
  scope: 'admin',
  annotations: { title: 'Revoke token', readOnlyHint: false, destructiveHint: true },
  cliHints: { name: 'token-revoke', positional: ['id'] },
  handler: async (ctx, p) => {
    const sql = sqlQueryForEngine(ctx.engine);
    const method = 'token_revoke';
    const principal = mintingPrincipal(ctx);
    if (!principal.allowed) {
      await writeAuthAudit(sql, {
        decision: 'deny',
        method,
        reason: 'revoke_principal_denied',
        actor: principal.actor,
      });
      throw new OperationError(
        'permission_denied',
        'token_revoke requires an allowlisted principal (admin scope or local CLI).',
      );
    }
    const id = String(p.id ?? '');
    if (!TOKEN_ID_RE.test(id)) {
      // Audited like every other deny; the raw (arbitrary caller input)
      // value is NOT copied into the audit row or the error message —
      // it could be anything, including a pasted secret.
      await writeAuthAudit(sql, {
        decision: 'deny',
        method,
        reason: 'invalid_token_id',
        actor: principal.actor,
      });
      throw new OperationError('invalid_params', 'not a token id (expected a UUID)');
    }
    // Pre-read identity for the audit row (id is unique; the row may already
    // be revoked — that still audits with full identity).
    let tokenName: string | undefined;
    let companySlug: string | undefined;
    try {
      const rows = await sql`SELECT name, company_slug FROM access_tokens WHERE id = ${id}::uuid`;
      tokenName = typeof rows[0]?.name === 'string' ? (rows[0].name as string) : undefined;
      companySlug = typeof rows[0]?.company_slug === 'string' ? (rows[0].company_slug as string) : undefined;
    } catch {
      try {
        const rows = await sql`SELECT name FROM access_tokens WHERE id = ${id}::uuid`;
        tokenName = typeof rows[0]?.name === 'string' ? (rows[0].name as string) : undefined;
      } catch {
        /* identity enrichment only — revocation proceeds regardless. */
      }
    }
    const revoked = await revokeLegacyTokenById(sql, id);
    const audit = await writeAuthAudit(sql, {
      decision: 'revoke',
      method,
      reason: revoked ? undefined : 'already_revoked_or_missing',
      tokenId: id,
      tokenName,
      companySlug,
      actor: principal.actor,
    });
    return {
      revoked,
      id,
      correlation_id: audit.correlationId,
      audit_ok: audit.ok,
    };
  },
};

export const authTokenOperations: Operation[] = [token_mint_scoped, token_revoke];
