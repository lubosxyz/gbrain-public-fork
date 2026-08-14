/**
 * KOM-277 — mcp_request_log retention.
 *
 * Verifies:
 *   - migration v128 lands mcp_request_log_purged (documented name + idempotent).
 *     Renumbered v123 -> v128 in the 0.42.57 -> 0.45.13 upstream merge, where
 *     upstream claimed v123-v127; the DDL is idempotent so a brain that already
 *     ran it as v123 re-runs it as v128 against the existing table.
 *   - purgeStaleMcpRequestLog deletes stale rows, keeps fresh ones, and folds
 *     the deleted rows' per-token count/max(created_at) into
 *     mcp_request_log_purged (round-trip, mirrors the v117 volunteer-events
 *     purge test in test/migrate.test.ts)
 *   - rows with a NULL token_name are deleted but never produce a purged-
 *     counters row (matches the `WHERE token_name IS NOT NULL` aggregation —
 *     a NULL can't satisfy the TEXT PRIMARY KEY anyway)
 *   - the DB-plane config key drives the default TTL when no explicit
 *     ttlDays is passed
 *   - multi-batch purge (more stale rows than one batch) still deletes
 *     everything and aggregates correctly across batches
 *   - fail-closed: purge returns 0 (never throws) when mcp_request_log_purged
 *     is absent
 *   - structural guard: the dream cycle's purge phase actually calls
 *     purgeStaleMcpRequestLog and reports the count (mirrors the
 *     fix-wave-structural.test.ts volunteer-events pin)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  purgeStaleMcpRequestLog,
  MCP_REQUEST_LOG_RETENTION_CONFIG_KEY,
  MCP_REQUEST_LOG_DEFAULT_TTL_DAYS,
} from '../src/core/mcp-request-log-retention.ts';

/** Insert one mcp_request_log row with an explicit created_at (for aging). */
async function insertLogRow(
  engine: PGLiteEngine,
  opts: { tokenName: string | null; daysAgo: number; operation?: string },
): Promise<void> {
  const when = new Date(Date.now() - opts.daysAgo * 86_400_000).toISOString();
  await engine.executeRaw(
    `INSERT INTO mcp_request_log (token_name, operation, status, created_at)
     VALUES ($1, $2, 'success', $3)`,
    [opts.tokenName, opts.operation ?? 'search', when],
  );
}

describe('v128 — mcp_request_log_purged_counters', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  test('v128 entry exists, named + idempotent', () => {
    const m = MIGRATIONS.find((x) => x.version === 128);
    expect(m).toBeDefined();
    expect(m!.name).toBe('mcp_request_log_purged_counters');
    expect(m!.idempotent).toBe(true);
  });

  test('LATEST_VERSION is at or above 128', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(128);
  });

  test('table exists after initSchema with the documented columns', async () => {
    const rows = await engine.executeRaw<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'mcp_request_log_purged' ORDER BY ordinal_position`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.get('token_name')?.is_nullable).toBe('NO'); // PRIMARY KEY implies NOT NULL
    expect(byName.get('purged_requests')?.is_nullable).toBe('NO');
    expect(byName.get('purged_requests')?.data_type).toBe('bigint');
    expect(byName.get('purged_last_used_at')?.is_nullable).toBe('YES');
  });

  test('token_name is the primary key', async () => {
    const rows = await engine.executeRaw<{ constraint_type: string }>(
      `SELECT tc.constraint_type
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'mcp_request_log_purged'
          AND kcu.column_name = 'token_name'
          AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(rows.length).toBe(1);
  });

  test('re-running the migration SQL is a no-op (idempotent CREATE TABLE IF NOT EXISTS)', async () => {
    const m = MIGRATIONS.find((x) => x.version === 128)!;
    await expect(engine.executeRaw(m.sql)).resolves.toBeDefined();
  });
});

describe('purgeStaleMcpRequestLog', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  async function reset(): Promise<void> {
    await engine.executeRaw(`DELETE FROM mcp_request_log`);
    await engine.executeRaw(`DELETE FROM mcp_request_log_purged`);
    await engine.executeRaw(`DELETE FROM config WHERE key = $1`, [MCP_REQUEST_LOG_RETENTION_CONFIG_KEY]);
  }

  test('deletes rows older than the TTL, keeps fresh ones, and folds counters per token', async () => {
    await reset();
    // token-a: 3 stale rows (40d old) + 1 fresh row (1d old)
    await insertLogRow(engine, { tokenName: 'token-a', daysAgo: 40 });
    await insertLogRow(engine, { tokenName: 'token-a', daysAgo: 41 });
    await insertLogRow(engine, { tokenName: 'token-a', daysAgo: 42 });
    await insertLogRow(engine, { tokenName: 'token-a', daysAgo: 1 });
    // token-b: 2 stale rows (35d old)
    await insertLogRow(engine, { tokenName: 'token-b', daysAgo: 35 });
    await insertLogRow(engine, { tokenName: 'token-b', daysAgo: 36 });
    // NULL token_name, stale — deleted, but must not produce a purged row.
    await insertLogRow(engine, { tokenName: null, daysAgo: 40 });

    const deleted = await purgeStaleMcpRequestLog(engine, 30);
    expect(deleted).toBe(6); // 3 (token-a) + 2 (token-b) + 1 (null token)

    const left = await engine.executeRaw<{ token_name: string | null }>(
      `SELECT token_name FROM mcp_request_log ORDER BY token_name`,
    );
    expect(left.length).toBe(1);
    expect(left[0].token_name).toBe('token-a'); // the 1-day-old row survives

    const purged = await engine.executeRaw<{ token_name: string; purged_requests: string | number; purged_last_used_at: string }>(
      `SELECT token_name, purged_requests, purged_last_used_at FROM mcp_request_log_purged ORDER BY token_name`,
    );
    expect(purged.length).toBe(2); // no row for NULL token_name
    const byName = new Map(purged.map((r) => [r.token_name, r]));
    expect(Number(byName.get('token-a')!.purged_requests)).toBe(3);
    expect(Number(byName.get('token-b')!.purged_requests)).toBe(2);
    // purged_last_used_at is the MAX created_at among the purged rows for
    // that token — token-a's purged rows were 40/41/42 days ago, so the max
    // (least-old) is ~40 days ago, not the surviving 1-day-old row.
    const tokenALastUsed = new Date(byName.get('token-a')!.purged_last_used_at).getTime();
    const expectedApprox = Date.now() - 40 * 86_400_000;
    expect(Math.abs(tokenALastUsed - expectedApprox)).toBeLessThan(5 * 60_000); // within 5 minutes
  });

  test('a second purge run accumulates onto the existing purged counters (ON CONFLICT DO UPDATE)', async () => {
    await reset();
    await insertLogRow(engine, { tokenName: 'token-c', daysAgo: 40 });
    const firstDeleted = await purgeStaleMcpRequestLog(engine, 30);
    expect(firstDeleted).toBe(1);

    await insertLogRow(engine, { tokenName: 'token-c', daysAgo: 45 });
    const secondDeleted = await purgeStaleMcpRequestLog(engine, 30);
    expect(secondDeleted).toBe(1);

    const rows = await engine.executeRaw<{ purged_requests: string | number }>(
      `SELECT purged_requests FROM mcp_request_log_purged WHERE token_name = 'token-c'`,
    );
    expect(Number(rows[0].purged_requests)).toBe(2); // accumulated across both runs
  });

  test('reads the TTL from DB-plane config (cycle.purge.mcp_request_log_retention_days) when no explicit ttlDays is passed', async () => {
    await reset();
    await engine.setConfig(MCP_REQUEST_LOG_RETENTION_CONFIG_KEY, '10');
    // 15 days old: stale under the configured 10-day TTL, fresh under the
    // MCP_REQUEST_LOG_DEFAULT_TTL_DAYS=30 default — proves the config value
    // is actually the one driving the cutoff, not the hardcoded default.
    await insertLogRow(engine, { tokenName: 'token-d', daysAgo: 15 });
    await insertLogRow(engine, { tokenName: 'token-d', daysAgo: 2 });

    const deleted = await purgeStaleMcpRequestLog(engine); // no ttlDays arg
    expect(deleted).toBe(1);

    const left = await engine.executeRaw<{ token_name: string }>(`SELECT token_name FROM mcp_request_log`);
    expect(left.length).toBe(1);
  });

  test('falls back to the default TTL when the config value is invalid/unset', async () => {
    await reset();
    await engine.setConfig(MCP_REQUEST_LOG_RETENTION_CONFIG_KEY, 'not-a-number');
    // 40 days old: stale under the 30-day default, which is what should apply
    // when the config value fails to parse.
    await insertLogRow(engine, { tokenName: 'token-e', daysAgo: 40 });
    const deleted = await purgeStaleMcpRequestLog(engine);
    expect(deleted).toBe(1);
    expect(MCP_REQUEST_LOG_DEFAULT_TTL_DAYS).toBe(30);
  });

  test('multi-batch purge deletes everything across more than one batch and aggregates correctly', async () => {
    await reset();
    // Bulk-insert 4500 stale rows for a single token — more than one
    // BATCH_SIZE (2000) worth — via generate_series so this stays fast.
    await engine.executeRaw(
      `INSERT INTO mcp_request_log (token_name, operation, status, created_at)
       SELECT 'token-bulk', 'search', 'success', now() - interval '40 days' - (g || ' seconds')::interval
       FROM generate_series(1, 4500) AS g`,
    );
    const deleted = await purgeStaleMcpRequestLog(engine, 30);
    expect(deleted).toBe(4500);

    const remaining = await engine.executeRaw<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM mcp_request_log WHERE token_name = 'token-bulk'`,
    );
    expect(Number(remaining[0].count)).toBe(0);

    const purgedRow = await engine.executeRaw<{ purged_requests: string | number }>(
      `SELECT purged_requests FROM mcp_request_log_purged WHERE token_name = 'token-bulk'`,
    );
    expect(Number(purgedRow[0].purged_requests)).toBe(4500);
  }, 30_000);

  test('fail-closed: returns 0 without throwing when mcp_request_log_purged is absent', async () => {
    await reset();
    await insertLogRow(engine, { tokenName: 'token-f', daysAgo: 40 });
    await engine.executeRaw(`DROP TABLE mcp_request_log_purged`);
    try {
      await expect(purgeStaleMcpRequestLog(engine, 30)).resolves.toBe(0);
      // The stale row must NOT have been deleted — fail-closed means no
      // destructive action was taken, not "deleted but didn't record it".
      const left = await engine.executeRaw<{ token_name: string }>(`SELECT token_name FROM mcp_request_log`);
      expect(left.length).toBe(1);
    } finally {
      // Restore the table so later tests in this file aren't affected.
      const m = MIGRATIONS.find((x) => x.version === 128)!;
      await engine.executeRaw(m.sql);
    }
  });
});

describe('KOM-277 — dream cycle purge-phase wiring (structural pin)', () => {
  test("the dream cycle's purge phase invokes purgeStaleMcpRequestLog and reports the count", () => {
    const src = readFileSync('src/core/cycle.ts', 'utf8');
    expect(src).toMatch(/purgeStaleMcpRequestLog\(engine\)/);
    expect(src).toMatch(/purged_mcp_request_log_count/);
  });

  test('serve-http admin agents metrics fold in mcp_request_log_purged', () => {
    const src = readFileSync('src/commands/serve-http.ts', 'utf8');
    expect(src).toMatch(/mcp_request_log_purged/);
    expect(src).toMatch(/purged_requests/);
    expect(src).toMatch(/purged_last_used_at/);
  });
});
