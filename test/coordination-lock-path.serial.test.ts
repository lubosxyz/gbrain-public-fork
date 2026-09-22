/**
 * The coordination lock must live OUTSIDE the canonical checkout (v0.51.0.0
 * persistence ownership). `GBRAIN_HOME` may point at the brain repository
 * itself, and then the brain's own persistence home is inside that checkout —
 * the reservation validator rejects such a lock, so `sources writer claim`
 * used to fail with recovery_required and every write fail-closed with
 * owner_unavailable. These tests pin the fallback that keeps the lock outside.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { withEnv } from './helpers/with-env.ts';
import { coordinationLockPath, isOutsideRoot } from '../src/core/persistence/coordination-lock.ts';
import { physicalRootReservationPath, readPhysicalRootReservation, repairReservationCoordinationPath,
  coordinationLockIsInsideRoot, reservationRepairGuardPath } from '../src/core/persistence/physical-root-record.ts';
import { coordinationNamespace, successorCoordinationPath } from '../src/core/persistence/coordination-lock.ts';
import { acquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { statSync } from 'node:fs';

const outside = (root: string, path: string) => {
  const rel = relative(root, path);
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
};

describe('coordination lock placement', () => {
  // GBRAIN_HOME == the source root: the default lock dir is inside the checkout.
  test('falls back outside when the brain home is the canonical root', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-root-')));
    const lock = await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: undefined },
      () => coordinationLockPath(root, '11111111-1111-4111-8111-111111111111'));
    expect(outside(root, lock)).toBe(true);
    expect(lock.startsWith(realpathSync(homedir()))).toBe(true);
    expect(lock.endsWith('11111111-1111-4111-8111-111111111111.lock')).toBe(true);
  });

  // The ordinary layout (brain home beside the repo) keeps using its own home.
  test('keeps the brain persistence home when it is already outside the root', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'gb-split-')));
    const home = join(base, 'home'); const root = join(base, 'repo');
    mkdirSync(home); mkdirSync(root);
    const lock = await withEnv({ GBRAIN_HOME: home, GBRAIN_COORDINATION_HOME: undefined },
      () => coordinationLockPath(root, '22222222-2222-4222-8222-222222222222'));
    expect(lock.startsWith(join(home, '.gbrain'))).toBe(true);
    expect(outside(root, lock)).toBe(true);
  });

  // An operator can place the fallback explicitly; it is still validated.
  test('honours GBRAIN_COORDINATION_HOME and rejects a relative one', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-root-')));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'gb-locks-')));
    const lock = await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: elsewhere },
      () => coordinationLockPath(root, '33333333-3333-4333-8333-333333333333'));
    expect(lock.startsWith(elsewhere)).toBe(true);
    await expect(withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: 'relative/locks' },
      () => coordinationLockPath(root, '44444444-4444-4444-8444-444444444444'))).rejects.toThrow();
  });

  // Two brains restored from one database clone keep the same worktree id on different checkouts.
  test('namespaces the shared fallback by canonical root', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    const a = realpathSync(mkdtempSync(join(tmpdir(), 'gb-clone-a-')));
    const b = realpathSync(mkdtempSync(join(tmpdir(), 'gb-clone-b-')));
    const lockA = await withEnv({ GBRAIN_HOME: a, GBRAIN_COORDINATION_HOME: undefined }, () => coordinationLockPath(a, id));
    const lockB = await withEnv({ GBRAIN_HOME: b, GBRAIN_COORDINATION_HOME: undefined }, () => coordinationLockPath(b, id));
    expect(lockA).not.toBe(lockB);
    expect(outside(a, lockA)).toBe(true);
    expect(outside(b, lockB)).toBe(true);
  });

  // A shared home plus identical local checkout paths on two hosts must not share one lock.
  test('namespaces the shared fallback by host identity as well as root', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-host-')));
    const homeA = realpathSync(mkdtempSync(join(tmpdir(), 'gb-hostA-')));
    const homeB = realpathSync(mkdtempSync(join(tmpdir(), 'gb-hostB-')));
    const nsA = await withEnv({ GBRAIN_HOME: homeA }, () => coordinationNamespace(root));
    const nsB = await withEnv({ GBRAIN_HOME: homeB }, () => coordinationNamespace(root));
    expect(nsA).not.toBe(nsB);
  });

  test('isOutsideRoot rejects a nested path and accepts a sibling', () => {
    expect(isOutsideRoot('/a/b', '/a/b/.gbrain/persistence/locks/x.lock')).toBe(false);
    expect(isOutsideRoot('/a/b', '/a/c/locks/x.lock')).toBe(true);
    expect(isOutsideRoot('/a/b', '/a/b')).toBe(false);
  });
});

/** A refused v0.51 claim leaves a reservation naming a lock inside the checkout. */
describe('reservation repair', () => {
  const writeBadReservation = (root: string, brainId: string, hostId: string, worktreeId: string) => {
    const info = statSync(root, { bigint: true });
    const record = { version: 1, token: randomUUID(), brainId, worktreeId, hostId, root,
      coordinationPath: join(root, '.gbrain', 'persistence', 'locks', `${worktreeId}.lock`),
      initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString() };
    const path = physicalRootReservationPath(root);
    writeFileSync(path, JSON.stringify(record));
    chmodSync(path, 0o600);
    return record;
  };

  test('moves the lock out of the checkout and keeps every identity field', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-wedged-')));
    const brainId = randomUUID(), hostId = randomUUID(), worktreeId = randomUUID();
    const before = writeBadReservation(root, brainId, hostId, worktreeId);
    expect(() => readPhysicalRootReservation(root)).toThrow();
    const repaired = await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: undefined },
      () => repairReservationCoordinationPath(root, id => coordinationLockPath(root, id), brainId, hostId));
    expect(coordinationLockIsInsideRoot(root, repaired!.coordinationPath)).toBe(false);
    expect(readPhysicalRootReservation(root)?.coordinationPath).toBe(repaired!.coordinationPath);
    // Everything except the lock location must survive byte for byte.
    const after = JSON.parse(readFileSync(physicalRootReservationPath(root), 'utf8'));
    for (const field of ['token','brainId','worktreeId','hostId','root','initialDevice','initialInode','initialBirth'] as const) {
      expect(after[field]).toBe((before as Record<string, unknown>)[field]);
    }
    expect(after.coordinationPath).not.toBe(before.coordinationPath);
  });

  // Each guard is checked on its own, so deleting either one fails a test.
  test('refuses a record belonging to another brain', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-foreign-brain-')));
    const hostId = randomUUID();
    writeBadReservation(root, randomUUID(), hostId, randomUUID());
    await expect(withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: undefined },
      () => repairReservationCoordinationPath(root, id => coordinationLockPath(root, id), randomUUID(), hostId))).rejects.toThrow();
    expect(JSON.parse(readFileSync(physicalRootReservationPath(root), 'utf8')).coordinationPath.startsWith(root)).toBe(true);
  });

  test('refuses a record reserved by another host', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-foreign-host-')));
    const brainId = randomUUID();
    writeBadReservation(root, brainId, randomUUID(), randomUUID());
    await expect(withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: undefined },
      () => repairReservationCoordinationPath(root, id => coordinationLockPath(root, id), brainId, randomUUID()))).rejects.toThrow();
  });

  // Serialization: while one repairer holds the guard, a second must refuse rather than race.
  test('refuses while another repairer holds the reservation guard', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-race-')));
    const brainId = randomUUID(), hostId = randomUUID();
    writeBadReservation(root, brainId, hostId, randomUUID());
    await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: undefined }, async () => {
      const guard = await acquireNativeLock(reservationRepairGuardPath(root), { timeoutMs: 1000 });
      expect(guard).not.toBeNull();
      try {
        await expect(repairReservationCoordinationPath(root, id => coordinationLockPath(root, id),
          brainId, hostId)).rejects.toThrow();
      } finally { await guard!.release(); }
    });
  });

  test('leaves a compliant reservation untouched', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'gb-ok-')));
    const home = join(base, 'home'); const root = join(base, 'repo');
    mkdirSync(home); mkdirSync(root);
    const brainId = randomUUID(), hostId = randomUUID(), worktreeId = randomUUID();
    const good = { version: 1, token: randomUUID(), brainId, worktreeId, hostId, root,
      coordinationPath: join(home, `${worktreeId}.lock`), initialDevice: null, initialInode: null, initialBirth: null };
    writeFileSync(physicalRootReservationPath(root), JSON.stringify(good));
    chmodSync(physicalRootReservationPath(root), 0o600);
    const same = await withEnv({ GBRAIN_HOME: home, GBRAIN_COORDINATION_HOME: undefined },
      () => repairReservationCoordinationPath(root, id => coordinationLockPath(root, id), brainId, hostId));
    expect(same?.coordinationPath).toBe(good.coordinationPath);
    expect(same?.token).toBe(good.token);
  });
});

/** Which lock a successor coordinates on after a verified transfer. */
describe('successor coordination path', () => {
  // A real directory: minting resolves the brain home, which must be writable.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-successor-')));
  const reserved = '/var/locks/reserved.lock';
  const recorded = '/var/locks/recorded.lock';

  test('the successor reservation wins over a recorded binding path', () => {
    expect(successorCoordinationPath(root, reserved, recorded, randomUUID())).toBe(reserved);
  });

  test('a recorded path is used when the successor has no reservation', () => {
    expect(successorCoordinationPath(root, null, recorded, randomUUID())).toBe(recorded);
  });

  test('a recorded path inside the successor root is ignored', async () => {
    const id = randomUUID();
    const inside = join(root, '.gbrain', 'persistence', 'locks', `${id}.lock`);
    const minted = await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: undefined },
      () => successorCoordinationPath(root, null, inside, id));
    expect(minted).not.toBe(inside);
    expect(isOutsideRoot(root, minted)).toBe(true);
  });

  test('neither recorded nor reserved mints a fresh path', async () => {
    const id = randomUUID();
    const minted = await withEnv({ GBRAIN_HOME: root, GBRAIN_COORDINATION_HOME: undefined },
      () => successorCoordinationPath(root, null, null, id));
    expect(minted.endsWith(`${id}.lock`)).toBe(true);
    expect(isOutsideRoot(root, minted)).toBe(true);
  });
});
