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
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath, sameRootDevice } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';

// APFS numbers volumes at mount time, so a reboot can give an unchanged checkout a new st_dev.
// Rewriting the recorded device number is exactly what the stamp check observes after such a reboot.
const darwin = process.platform === 'darwin';

describe('root device comparison', () => {
  test('macOS treats a renumbered volume as the same root; other platforms stay strict', () => {
    expect(sameRootDevice('16777230', 16777230n, 'linux')).toBe(true);
    expect(sameRootDevice('16777230', 16777229n, 'linux')).toBe(false);
    expect(sameRootDevice('16777230', 16777229n, 'win32')).toBe(false);
    expect(sameRootDevice('16777230', 16777229n, 'darwin')).toBe(true);
  });
  test('a missing or malformed recorded device never matches', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(sameRootDevice(null, 16777229n, platform)).toBe(false);
      expect(sameRootDevice('malformed', 16777229n, platform)).toBe(false);
      expect(sameRootDevice('', 16777229n, platform)).toBe(false);
    }
  });
});

describe('writes survive a reboot that renumbers the volume', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-device-drift-')));
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

  async function claimed(run: (f: { root: string; home: string; binding: NonNullable<Awaited<ReturnType<typeof getWorktreeBinding>>> }) => Promise<void>) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `drift-${randomUUID().slice(0, 8)}`;
    writeFileSync(join(root, 'note.md'), 'Canonical example');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: source, path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
      await run({ root, home, binding: (await getWorktreeBinding(engine, source))! });
    });
  }
  function editStamp(root: string, change: (stamp: Record<string, string>) => void) {
    const path = join(root, PHYSICAL_ROOT_MARKER), stamp = JSON.parse(readFileSync(path, 'utf8'));
    change(stamp); writeFileSync(path, JSON.stringify(stamp));
  }
  const renumber = (value: string) => String(BigInt(value) + 7n);

  test.skipIf(!darwin)('macOS: the writer lock and root check pass after st_dev renumbering, without self-transfer', () => claimed(async f => {
    const before = readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8');
    editStamp(f.root, stamp => { stamp.device = renumber(stamp.device); });
    expect(() => assertPhysicalRoot(f.root, { worktreeId: f.binding.worktree_id, coordinationPath: f.binding.coordination_path })).not.toThrow();
    const lock = await acquireWorktree(f.binding); expect(lock).not.toBeNull(); await lock?.release();
    // Tolerance is read-only: ownership is unchanged and no transfer happened.
    const after = (await getWorktreeBinding(engine, f.binding.source_id))!;
    expect(after.owner_epoch).toBe(f.binding.owner_epoch);
    expect(JSON.parse(readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8')).token).toBe(JSON.parse(before).token);
  }));

  test.skipIf(!darwin)('macOS: a renumbered device never excuses any other identity change', () => claimed(async f => {
    const original = readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8');
    for (const change of [
      (s: Record<string, string>) => { s.token = randomUUID(); },
      (s: Record<string, string>) => { s.inode = renumber(s.inode); },
      (s: Record<string, string>) => { s.birth = renumber(s.birth); },
      (s: Record<string, string>) => { s.worktreeId = randomUUID(); },
      (s: Record<string, string>) => { s.root = join(f.home, 'copy'); },
      (s: Record<string, string>) => { s.device = 'malformed'; },
    ]) {
      writeFileSync(join(f.root, PHYSICAL_ROOT_MARKER), original);
      editStamp(f.root, stamp => { stamp.device = renumber(stamp.device); change(stamp); });
      await expect(acquireWorktree(f.binding)).rejects.toMatchObject({ code: 'recovery_required' });
    }
  }));

  test.skipIf(!darwin)('macOS: a copied checkout with the copied stamp is still refused', () => claimed(async f => {
    const copy = join(f.home, 'copy'); mkdirSync(copy);
    writeFileSync(join(copy, PHYSICAL_ROOT_MARKER), readFileSync(join(f.root, PHYSICAL_ROOT_MARKER)), { mode: 0o600 });
    expect(() => assertPhysicalRoot(copy, { worktreeId: f.binding.worktree_id })).toThrow();
  }));

  test.skipIf(!darwin)('macOS: deliberate self-transfer still re-stamps the current device', () => claimed(async f => {
    const recorded = JSON.parse(readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8')).device;
    editStamp(f.root, stamp => { stamp.device = renumber(stamp.device); });
    const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
      runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
    const prepared = await administer('writer_transfer_prepare', { source_id: f.binding.source_id, self_transfer: true }) as any;
    await administer('writer_transfer_accept', { source_id: f.binding.source_id, path: f.root, expected_epoch: prepared.owner_epoch,
      manifest: prepared.manifest.digest, self_transfer: true });
    expect(JSON.parse(readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8')).device).toBe(recorded);
    expect((await getWorktreeBinding(engine, f.binding.source_id))?.owner_epoch).toBe('2');
  }));

  test.skipIf(darwin)('other platforms: st_dev drift still requires deliberate self-transfer', () => claimed(async f => {
    editStamp(f.root, stamp => { stamp.device = renumber(stamp.device); });
    await expect(acquireWorktree(f.binding)).rejects.toThrow('device identifier');
  }));

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
        reservation.initialDevice = renumber(reservation.initialDevice); reservation[field] = renumber(reservation[field]);
      }, false);
    }
  });

  test.skipIf(darwin)('other platforms: an interrupted first claim refuses st_dev renumbering', () =>
    interruptedClaim(reservation => { reservation.initialDevice = renumber(reservation.initialDevice); }, false));
});
