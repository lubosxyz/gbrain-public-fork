import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { assertPhysicalRoot, reservePhysicalRoot } from '../src/core/persistence/physical-root.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';

const darwin = process.platform === 'darwin';
const renumber = (value: string) => String(BigInt(value) + 7n);
describe('interrupted first claim device recovery', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-first-claim-')));
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });
  async function interruptedClaim(change: (reservation: Record<string, string>) => void, resumes: boolean) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `drift-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const hostId = localHostId();
      await expect(engine.transaction(async tx => {
        await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
        await reservePhysicalRoot(tx, root, { hostId });
        throw new Error('Interrupted before binding and root stamp');
      })).rejects.toThrow('Interrupted');
      const path = physicalRootReservationPath(root), reservation = JSON.parse(readFileSync(path, 'utf8'));
      change(reservation); writeFileSync(path, JSON.stringify(reservation));
      if (!resumes) {
        await expect(claimWorktree(engine, source, root, hostId)).rejects.toMatchObject({ code: 'recovery_required' });
        return;
      }
      const binding = await claimWorktree(engine, source, root, hostId);
      const lock = await acquireWorktree(binding); expect(lock).not.toBeNull(); await lock?.release();
    });
  }

  test.skipIf(!darwin)('macOS: an interrupted first claim resumes after st_dev renumbering', () =>
    interruptedClaim(reservation => { reservation.initialDevice = renumber(reservation.initialDevice); }, true));

  test.skipIf(!darwin)('macOS: an interrupted first claim still refuses a renumbered device with another identity change', async () => {
    for (const field of ['initialInode', 'initialBirth'] as const) {
      await interruptedClaim(reservation => {
        reservation.initialDevice = renumber(reservation.initialDevice); reservation[field] = String(BigInt(reservation[field]) + 1000000n);
      }, false);
    }
  });

  test.skipIf(darwin)('other platforms: an interrupted first claim refuses st_dev renumbering', () =>
    interruptedClaim(reservation => { reservation.initialDevice = renumber(reservation.initialDevice); }, false));
});
