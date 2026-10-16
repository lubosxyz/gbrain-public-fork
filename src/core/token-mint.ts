import { executeRawJsonb } from './sql-query.ts';
/**
 * token-mint.ts — legacy bearer-token mint/revoke for programmatic callers
 * (#4043 `gbrain bootstrap harness`; extracted from src/commands/auth.ts's
 * private logic, using the canonical hashToken/generateToken from utils.ts).
 *
 * Least-privilege by construction: scopes land in the original-schema
 * `access_tokens.scopes TEXT[]` column (structurally immune to the
 * permissions-object-replacement wipe class). F3: the grant lands in the
 * unified columns (source_grant, source_id, federated_read,
 * allowed_operations, takes_holders) with a `permissions` JSONB mirror for
 * older binaries; the federation grant is an array, element 0 = write floor.
 *
 * Rotation contract [C7]: mint FIRST, revoke the previous token BY ID only
 * after the new one is wired and smoke-tested. revokeLegacyTokenById never
 * touches same-name siblings — names are not unique and may belong to
 * hand-minted tokens.
 */

import type { BrainEngine } from './engine.ts';
import { ALLOWED_SCOPES_LIST, assertAllowedScopes } from './scope.ts';
import type { SqlQuery } from './sql-query.ts';
import { opError } from './ops/contract.ts';
import { generateToken, hashToken, isUndefinedColumnError } from './utils.ts';
import { permissionsMirror, tokenGrantColumnValues, tokenGrantFromPermissions, TOKEN_GRANT_COLUMNS, type GrantSources, type PrincipalGrant } from './grants/model.ts';

/** Canonical token-id shape — shared with the `auth revoke --id` CLI gate. */
export const TOKEN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintLegacyTokenOpts {
  name: string;
  /** Per-token takes-holder allow-list; harness default ['world']. `[]` is stored as deny-all. */
  takesHolders: string[];
  /** Scope grant → the scopes TEXT[] column. Must be non-empty known scopes. */
  scopes: string[];
  /**
   * Federation grant → permissions.source_id (array; element 0 = write
   * floor). Omit for the historical default-source floor; `[]` is stored as
   * the explicit no-source grant.
   */
  sourceGrant?: string[];
  allowedOperations?: string[];
}

export interface MintedLegacyToken {
  /** Plaintext token — shown/wired once, never stored. */
  token: string;
  /** Row id — the ONLY safe revocation key (names are not unique). */
  id: string;
  name: string;
  scopes: string[];
  /** Rotation only: operations this run would grant that the carried snapshot withheld. */
  withheldOperations?: string[];
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
  if (opts.allowedOperations !== undefined) {
    const { operations } = await import('./operations.ts');
    const names = new Set(operations.filter(op => !op.localOnly).map(op => op.name));
    if (!Array.isArray(opts.allowedOperations) || opts.allowedOperations.some(name => !names.has(name))) {
      throw new Error('allowedOperations must contain only registered remote operation names');
    }
  }
  const token = generateToken('gbrain_');
  const sources: GrantSources = opts.sourceGrant === undefined ? { kind: 'default' }
    : opts.sourceGrant.length === 0 ? { kind: 'none' }
    : { kind: 'federated', writeSource: opts.sourceGrant[0], readSources: [...opts.sourceGrant] };
  const rows = await insertUnifiedToken(engine, {
    name: opts.name, tokenHash: hashToken(token), scopes: opts.scopes,
    grant: { sources, takesHolders: opts.takesHolders, allowedOperations: opts.allowedOperations === undefined ? null : [...new Set(opts.allowedOperations)] },
  });
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
 * Insert a token born on the unified grant shape: the grant columns at
 * revision 1 plus the `permissions` JSONB mirror older binaries read
 * (`GRANT_MIRROR_WINDOW_ENDS`). A brain whose schema predates the columns
 * refuses with `migrations_pending` instead of writing a JSONB-only grant.
 * Scopes bind as a Postgres array literal through a TEXT param + ::text[]
 * (values are allowlisted); omitted scopes stay NULL (grandfathered full
 * access). The JSONB object binds as a raw object, exactly as executeRawJsonb
 * binds it (no double-encode).
 */
export async function insertUnifiedToken(engine: BrainEngine, opts: {
  name: string; tokenHash: string; scopes?: string[];
  grant: Pick<PrincipalGrant, 'sources' | 'allowedOperations' | 'takesHolders'>;
}): Promise<Array<{ id: string }>> {
  const scopes = opts.scopes === undefined ? null : `{${opts.scopes.join(',')}}`;
  try {
    return await engine.executeRaw<{ id: string }>(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, ${TOKEN_GRANT_COLUMNS.join(', ')}, grant_revision)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, $7::text[], $8::text[], $9::text[], 1)
       RETURNING id`,
      [opts.name, opts.tokenHash, scopes, permissionsMirror(opts.grant, {}), ...tokenGrantColumnValues(opts.grant)],
    );
  } catch (e) {
    // isUndefinedColumnError also matches message-shaped variants: some
    // driver-wrapped errors drop the SQLSTATE code.
    if (['scopes', 'permissions', 'grant_revision', ...TOKEN_GRANT_COLUMNS].some(column => isUndefinedColumnError(e, column))) {
      throw opError('migrations_pending',
        'This brain is missing the access-token grant columns, so it cannot mint a token.',
        'Apply the pending schema migrations on the brain host, then mint the token again.',
        { why: 'Tokens are born on the unified grant columns; a brain whose schema predates them has not run its migrations.',
          fix: { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: 'agent', requires_exclusive: true,
            why: 'Applies the pending schema migrations, including the token grant columns; no user decision needed.', verify: { argv: ['gbrain', 'doctor', '--json'] } } });
    }
    throw e;
  }
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

/**
 * #5893 rotation carry-over: the grants a rotated harness token inherits from
 * the token it replaces. Takes holders and the source grant are carried as
 * stored, explicit empty lists included (an explicit `--source` on this run
 * wins over the stored source grant). A stored operation snapshot is carried
 * as stored, narrowed to the operations this run would grant, plus only the
 * operations a skills-policy change adds; `[]` stays `[]`. Operations new
 * since the snapshot are withheld (reported, never silently granted): widen
 * with `gbrain auth rescope --token <name> --refresh-operations`.
 *
 * F3: the prior grant is read from its `permissions` JSONB through the shared
 * parser. On a unified row that JSONB mirrors the columns. On a drifted row
 * (an older gbrain edited the JSONB after migration) the edit is the newest
 * operator intent, so rotation carries it, the same resolution as
 * `auth rescope --adopt-permissions`; the replacement is born unified and the
 * drifted row is revoked after the swap.
 */
export function carryLegacyGrant(priorRaw: unknown, fresh: {
  sourceGrant?: string[]; explicitSource: boolean; allowedOperations: string[]; policyAdded: string[];
}): { takesHolders: string[]; sourceGrant?: string[]; allowedOperations: string[]; withheldOperations: string[] } {
  const prior = tokenGrantFromPermissions(priorRaw);
  const takesHolders = prior.takesHolders ?? ['world'];
  const stored = prior.sources;
  const storedSource = stored.kind === 'default' ? undefined : stored.kind === 'none' ? []
    : stored.kind === 'scalar' ? [stored.writeSource] : stored.readSources;
  const sourceGrant = fresh.explicitSource || storedSource === undefined ? fresh.sourceGrant : storedSource;
  const priorOps = prior.allowedOperations ?? undefined;
  if (priorOps === undefined) return { takesHolders, sourceGrant, allowedOperations: fresh.allowedOperations, withheldOperations: [] };
  const allowedOperations = priorOps.length === 0 ? [] : [...new Set([
    ...priorOps.filter(op => fresh.allowedOperations.includes(op)), ...fresh.policyAdded,
  ])].sort();
  return { takesHolders, sourceGrant, allowedOperations,
    withheldOperations: fresh.allowedOperations.filter(op => !allowedOperations.includes(op)) };
}

/** The stored grant of an active token, or undefined when it is gone or revoked. */
export async function readActiveTokenPermissions(engine: BrainEngine, id: string): Promise<unknown> {
  if (!TOKEN_ID_RE.test(id)) return undefined;
  const [row] = await engine.executeRaw<{ permissions: unknown }>(
    'SELECT permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL', [id]);
  return row ? row.permissions ?? {} : undefined;
}
