/**
 * Fork/upstream migration-number reconciliation for the two independently
 * shipped v128 meanings.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('migration v150 — fork/upstream reconciliation (v128 lane replayed after the 0.50 merge renumbered it out of v131)', () => {
  test('contains both independently shipped v128 semantics and is idempotent', () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 150);
    expect(migration?.name).toBe('fork_upstream_v131_v132_reconciliation');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('CREATE TABLE IF NOT EXISTS mcp_request_log_purged');
    expect(migration?.sql).toContain('UPDATE minion_jobs');
    expect(migration?.sql).toContain("error_text = 'v131: superseded duplicate autopilot cycle'");
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(150);
  });

  test('repairs an upstream-shaped v130 brain that never created the fork table', async () => {
    await engine.executeRaw('DROP TABLE IF EXISTS mcp_request_log_purged');
    await engine.setConfig('version', '130');

    const result = await runMigrations(engine);

    // Everything past v130 applies on this brain (v131 + any newer tail
    // migrations) — the assertion tracks the registry so a new tail
    // migration doesn't break this reconciliation test.
    expect(result.applied).toBe(MIGRATIONS.filter(m => m.version > 130).length);
    const rows = await engine.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'mcp_request_log_purged'`,
    );
    expect(rows).toHaveLength(1);
  });

  test('repairs a fork-shaped v128 brain that skipped upstream v128', async () => {
    const old = await queue.add('autopilot-cycle', { source_id: 'reconcile' }, {
      idempotency_key: 'autopilot-cycle:reconcile:old',
    });
    const fresh = await queue.add('autopilot-cycle', { source_id: 'reconcile' }, {
      idempotency_key: 'autopilot-cycle:reconcile:fresh',
    });
    await engine.executeRaw(
      `UPDATE minion_jobs
          SET timeout_ms = NULL,
              created_at = CASE WHEN id = $1 THEN now() - interval '2 hours' ELSE now() END
        WHERE id IN ($1, $2)`,
      [old.id, fresh.id],
    );
    await engine.setConfig('version', '128');

    await runMigrations(engine);

    const rows = await engine.executeRaw<{ id: number; status: string; timeout_ms: number | string | null }>(
      `SELECT id, status, timeout_ms FROM minion_jobs WHERE id IN ($1, $2) ORDER BY id`,
      [old.id, fresh.id],
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    expect(Number(byId.get(old.id)?.timeout_ms)).toBe(1_800_000);
    expect(Number(byId.get(fresh.id)?.timeout_ms)).toBe(1_800_000);
    expect(byId.get(old.id)?.status).toBe('cancelled');
    expect(byId.get(fresh.id)?.status).toBe('waiting');
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    const rerun = await runMigrations(engine);
    expect(rerun.applied).toBe(0);
  });
});
