/**
 * token-mint.ts — legacy bearer-token mint/revoke for programmatic callers
 * (#4043 `gbrain bootstrap harness`; extracted from src/commands/auth.ts's
 * private logic, using the canonical hashToken/generateToken from utils.ts).
 *
 * Least-privilege by construction: scopes land in the original-schema
 * `access_tokens.scopes TEXT[]` column (structurally immune to the
 * permissions-object-replacement wipe class), and the federation grant rides
 * `permissions.source_id` as an array (element 0 = write floor — the
 * parseLegacyTokenScope contract).
 *
 * Rotation contract [C7]: mint FIRST, revoke the previous token BY ID only
 * after the new one is wired and smoke-tested. revokeLegacyTokenById never
 * touches same-name siblings — names are not unique and may belong to
 * hand-minted tokens.
 */

import type { BrainEngine } from './engine.ts';
import { ALLOWED_SCOPES_LIST, assertAllowedScopes } from './scope.ts';
import { executeRawJsonb, type SqlQuery } from './sql-query.ts';
import { generateToken, hashToken, isUndefinedColumnError } from './utils.ts';

/** Canonical token-id shape — shared with the `auth revoke --id` CLI gate. */
export const TOKEN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintLegacyTokenOpts {
  name: string;
  /** Per-token takes-holder allow-list; harness default ['world']. */
  takesHolders: string[];
  /** Scope grant → the scopes TEXT[] column. Must be non-empty known scopes. */
  scopes: string[];
  /**
   * Federation grant → permissions.source_id (array; element 0 = write
   * floor). Omit for the historical default-source floor.
   */
  sourceGrant?: string[];
}

export interface MintedLegacyToken {
  /** Plaintext token — shown/wired once, never stored. */
  token: string;
  /** Row id — the ONLY safe revocation key (names are not unique). */
  id: string;
  name: string;
  scopes: string[];
}

/**
 * Mint a scoped legacy bearer token. Throws on unknown/empty scopes (typos
 * fail loudly at mint time — the verify path treats a filtered-empty array
 * as deny, so a silent bad write would brick the token, not widen it).
 */
export async function mintLegacyToken(
  engine: BrainEngine,
  opts: MintLegacyTokenOpts,
): Promise<MintedLegacyToken> {
  if (!opts.name || !opts.name.trim()) {
    throw new Error('token name is required');
  }
  if (opts.scopes.length === 0) {
    throw new Error(`token scopes must be a non-empty subset of: ${ALLOWED_SCOPES_LIST.join(', ')}`);
  }
  assertAllowedScopes(opts.scopes);
  const takesHolders = opts.takesHolders.length > 0 ? opts.takesHolders : ['world'];

  const token = generateToken('gbrain_');
  const hash = hashToken(token);
  const permissions: Record<string, unknown> = { takes_holders: takesHolders };
  if (opts.sourceGrant && opts.sourceGrant.length > 0) {
    permissions.source_id = opts.sourceGrant;
  }

  // Scopes bind as a Postgres array literal through a TEXT param + ::text[]
  // cast — values are allowlisted ([a-z_]+), so the literal needs no quoting,
  // and the same SQL runs on both engines (a bare JS array param would bind
  // engine-dependently; the JSONB object goes through executeRawJsonb per the
  // repo invariant).
  const scopesLiteral = `{${opts.scopes.join(',')}}`;
  let rows: Array<{ id: string }>;
  try {
    rows = await executeRawJsonb<{ id: string }>(
      engine,
      `INSERT INTO access_tokens (name, token_hash, permissions, scopes)
       VALUES ($1, $2, $4::jsonb, $3::text[])
       RETURNING id`,
      [opts.name, hash, scopesLiteral],
      [permissions],
    );
  } catch (e) {
    // isUndefinedColumnError also matches message-shaped variants — some
    // driver-wrapped errors drop the SQLSTATE code.
    if (isUndefinedColumnError(e, 'scopes') || isUndefinedColumnError(e, 'permissions')) {
      throw new Error(
        'this brain is missing token columns (undefined column on access_tokens) — ' +
          'run `gbrain apply-migrations` and retry.',
      );
    }
    throw e;
  }
  const id = rows[0]?.id;
  if (!id) throw new Error('token insert returned no id');
  return { token, id, name: opts.name, scopes: [...opts.scopes] };
}

// ---------------------------------------------------------------------------
// v132 tenant-remediation lane: scoped short-TTL tenant minting.
// ---------------------------------------------------------------------------

/** Hard TTL ceiling for tenant-scoped tokens (normative: 60 minutes). */
export const MAX_SCOPED_TOKEN_TTL_SECONDS = 3600;
export const DEFAULT_SCOPED_TOKEN_TTL_SECONDS = 3600;

/** Same shape as sources.id / identity companySlug conventions. */
export const COMPANY_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface MintScopedTenantTokenOpts {
  name: string;
  /**
   * Server-stored tenant identity. Supplied by the ALLOWLISTED minting
   * principal (which owns the canonical company registry); after mint it is
   * the only tenant source whoami reports for this token.
   */
  companySlug: string;
  /** 1..3600 seconds; > MAX_SCOPED_TOKEN_TTL_SECONDS is a DENY, not a clamp. */
  ttlSeconds?: number;
  /**
   * Requested grant. When provided it MUST be exactly ['read'] — every
   * non-exact variant (wider, narrower, reordered additions) is refused
   * before any row is written. Omitted = ['read'].
   */
  requestedScopes?: string[];
  /** Optional federation grant, same semantics as MintLegacyTokenOpts. */
  sourceGrant?: string[];
  /** Server-stamped minting principal (audit actor; never a trust input). */
  mintedBy: string;
}

export interface MintedScopedTenantToken extends MintedLegacyToken {
  companySlug: string;
  /** ISO timestamp of the DB-computed (server-time) expiry. */
  expiresAt: string;
}

/** Thrown on any pre-insert validation deny; carries a stable reason code. */
export class ScopedMintDenied extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'ScopedMintDenied';
  }
}

/**
 * Mint a tenant-scoped, short-TTL, read-only bearer token. All validation
 * happens BEFORE any write — a deny leaves zero rows behind (the caller
 * audits the deny). Expiry is computed in the DATABASE from server time
 * (`now() + ttl`), never from caller-supplied clocks.
 */
export async function mintScopedTenantToken(
  engine: BrainEngine,
  opts: MintScopedTenantTokenOpts,
): Promise<MintedScopedTenantToken> {
  if (!opts.name || !opts.name.trim()) {
    throw new ScopedMintDenied('invalid_name', 'token name is required');
  }
  // whoami distinguishes OAuth clients by the `gbrain_cl_` clientId prefix;
  // legacy tokens reuse `name` as clientId, so a token NAMED with that
  // prefix would masquerade as an OAuth identity and suppress the tenant/
  // legacy marker. Refuse it at mint time.
  if (/^gbrain_cl_/i.test(opts.name.trim())) {
    throw new ScopedMintDenied('invalid_name', "token name must not start with the OAuth client prefix 'gbrain_cl_'");
  }
  if (!COMPANY_SLUG_RE.test(opts.companySlug ?? '')) {
    throw new ScopedMintDenied(
      'invalid_company_slug',
      'company_slug must match ' + COMPANY_SLUG_RE.source,
    );
  }
  const ttl = opts.ttlSeconds ?? DEFAULT_SCOPED_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_SCOPED_TOKEN_TTL_SECONDS) {
    throw new ScopedMintDenied(
      'ttl_exceeded',
      `ttl_seconds must be an integer in [1, ${MAX_SCOPED_TOKEN_TTL_SECONDS}] (60-minute hard cap)`,
    );
  }
  if (opts.requestedScopes !== undefined) {
    const s = opts.requestedScopes;
    const exactRead = Array.isArray(s) && s.length === 1 && s[0] === 'read';
    if (!exactRead) {
      // Deliberately does NOT echo the submitted value: `scopes` is
      // untrusted caller input and this message lands in mcp_request_log /
      // SSE via the transport error path — a pasted secret must never
      // round-trip into logs.
      throw new ScopedMintDenied(
        'invalid_scope_request',
        "scoped tenant tokens carry exactly ['read'] (submitted value withheld from this message)",
      );
    }
  }
  if (!opts.mintedBy || !opts.mintedBy.trim()) {
    throw new ScopedMintDenied('invalid_minter', 'mintedBy principal is required');
  }

  const token = generateToken('gbrain_');
  const hash = hashToken(token);
  const permissions: Record<string, unknown> = { takes_holders: ['world'] };
  if (opts.sourceGrant && opts.sourceGrant.length > 0) {
    permissions.source_id = opts.sourceGrant;
  }

  let rows: Array<{ id: string; expires_at: string | Date }>;
  try {
    rows = await executeRawJsonb<{ id: string; expires_at: string | Date }>(
      engine,
      `INSERT INTO access_tokens (name, token_hash, permissions, scopes, company_slug, expires_at, minted_by)
       VALUES ($1, $2, $6::jsonb, '{read}'::text[], $3, now() + ($4::int * interval '1 second'), $5)
       RETURNING id, expires_at`,
      [opts.name, hash, opts.companySlug, ttl, opts.mintedBy],
      [permissions],
    );
  } catch (e) {
    if (
      isUndefinedColumnError(e, 'company_slug') ||
      isUndefinedColumnError(e, 'expires_at') ||
      isUndefinedColumnError(e, 'minted_by') ||
      isUndefinedColumnError(e, 'scopes') ||
      isUndefinedColumnError(e, 'permissions')
    ) {
      throw new ScopedMintDenied(
        'schema_out_of_date',
        'this brain is missing tenant-token columns on access_tokens — run `gbrain apply-migrations` and retry.',
      );
    }
    throw e;
  }
  const row = rows[0];
  if (!row?.id) throw new Error('token insert returned no id');
  const expiresAt =
    row.expires_at instanceof Date ? row.expires_at.toISOString() : new Date(row.expires_at).toISOString();
  return {
    token,
    id: row.id,
    name: opts.name,
    scopes: ['read'],
    companySlug: opts.companySlug,
    expiresAt,
  };
}

/**
 * Revoke exactly one token by row id. Returns false when no ACTIVE row with
 * that id exists (already revoked or never existed) — callers treat that as
 * already-done, not failure.
 */
export async function revokeLegacyTokenById(sql: SqlQuery, id: string): Promise<boolean> {
  if (!TOKEN_ID_RE.test(id)) {
    throw new Error(`not a token id (expected a UUID): ${id}`);
  }
  const rows = await sql`
    UPDATE access_tokens SET revoked_at = now()
    WHERE id = ${id}::uuid AND revoked_at IS NULL
    RETURNING 1 AS ok
  `;
  return rows.length > 0;
}
