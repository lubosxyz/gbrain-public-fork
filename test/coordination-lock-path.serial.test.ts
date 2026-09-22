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
import { withEnv } from './helpers/with-env.ts';
import { coordinationLockPath, isOutsideRoot } from '../src/core/persistence/coordination-lock.ts';

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

  test('isOutsideRoot rejects a nested path and accepts a sibling', () => {
    expect(isOutsideRoot('/a/b', '/a/b/.gbrain/persistence/locks/x.lock')).toBe(false);
    expect(isOutsideRoot('/a/b', '/a/c/locks/x.lock')).toBe(true);
    expect(isOutsideRoot('/a/b', '/a/b')).toBe(false);
  });
});
