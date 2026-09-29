import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acceptWriterTransfer, acquireWorktree, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { readPhysicalRootReservation } from '../src/core/persistence/physical-root.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { withEnv } from './helpers/with-env.ts';

const directory = mkdtempSync(join(tmpdir(), 'gbrain-self-transfer-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

/** One claimed canonical checkout owned by a single host home. */
async function claimed() {
  const base = join(directory, randomUUID()); mkdirSync(base);
  const root = join(base, 'canonical'); mkdirSync(root); writeFileSync(join(root, 'page.md'), 'Canonical example');
  const home = join(base, 'home'); mkdirSync(home);
  const source = `self-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
  const host = await withEnv({ GBRAIN_HOME: home }, () => localHostId());
  const binding = await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, source, root, host));
  return { base, root, home, source, host, binding };
}

/** Simulate a reboot that renumbered the volume: only the stamp's st_dev no longer matches. */
function driftDevice(root: string): string {
  const path = join(root, PHYSICAL_ROOT_MARKER);
  const stamp = JSON.parse(readFileSync(path, 'utf8'));
  stamp.device = String(BigInt(stamp.device) + 5n);
  writeFileSync(path, JSON.stringify(stamp));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  return stamp.device;
}

test('device-only drift after a reboot fails closed until a deliberate self-transfer re-stamps the same root', async () => {
  const f = await claimed();
  const tokenBefore = readPhysicalRootReservation(f.root)!.token;
  const staleDevice = driftDevice(f.root);
  await expect(acquireWorktree(f.binding)).rejects.toMatchObject({ code: 'recovery_required' });
  await withEnv({ GBRAIN_HOME: f.home }, async () => {
    // An ordinary transfer still refuses: it must prove the full physical identity first.
    await expect(prepareWriterTransfer(engine, f.source, f.host)).rejects.toMatchObject({ code: 'recovery_required' });
    const prepared = await prepareWriterTransfer(engine, f.source, f.host, { selfTransfer: true });
    expect(prepared.manifest.self_transfer).toMatchObject({ device_recorded: staleDevice, device_current: statSync(f.root, { bigint: true }).dev.toString() });
    await acceptWriterTransfer(engine, f.source, f.root, prepared.owner_epoch, prepared.manifest.digest, f.host, { selfTransfer: true });
  });
  const after = (await withEnv({ GBRAIN_HOME: f.home }, () => getWorktreeBinding(engine, f.source, f.host)))!;
  expect(after.state).toBe('active');
  expect(String(after.owner_epoch)).toBe(String(BigInt(f.binding.owner_epoch) + 1n));
  expect(after.local_path).toBe(f.binding.local_path);
  expect(after.coordination_path).toBe(f.binding.coordination_path);
  const stamp = JSON.parse(readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8'));
  expect(stamp.device).toBe(statSync(f.root, { bigint: true }).dev.toString());
  expect(stamp.token).toBe(tokenBefore);
  expect(readPhysicalRootReservation(f.root)!.token).toBe(tokenBefore);
  const lock = await acquireWorktree(after); expect(lock).not.toBeNull(); await lock?.release();
});

test('self-transfer refuses a replaced checkout: a new inode is not device drift', async () => {
  const f = await claimed();
  const old = join(f.base, 'old'); renameSync(f.root, old); cpSync(old, f.root, { recursive: true });
  await withEnv({ GBRAIN_HOME: f.home }, async () => {
    await expect(prepareWriterTransfer(engine, f.source, f.host, { selfTransfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
  });
  const binding = (await getWorktreeBinding(engine, f.source, f.host))!;
  expect(binding.state).toBe('active');
});

test('self-transfer accept must target the recorded root and the prepared mode', async () => {
  const f = await claimed();
  driftDevice(f.root);
  const elsewhere = join(f.base, 'elsewhere'); cpSync(f.root, elsewhere, { recursive: true });
  rmSync(join(elsewhere, PHYSICAL_ROOT_MARKER));
  await withEnv({ GBRAIN_HOME: f.home }, async () => {
    const prepared = await prepareWriterTransfer(engine, f.source, f.host, { selfTransfer: true });
    await expect(acceptWriterTransfer(engine, f.source, elsewhere, prepared.owner_epoch, prepared.manifest.digest, f.host, { selfTransfer: true }))
      .rejects.toMatchObject({ code: 'source_changed' });
    // A self-transfer preparation cannot be consumed by an ordinary accept, nor the reverse.
    await expect(acceptWriterTransfer(engine, f.source, f.root, prepared.owner_epoch, prepared.manifest.digest, f.host))
      .rejects.toMatchObject({ code: 'writer_transfer_conflict' });
    await acceptWriterTransfer(engine, f.source, f.root, prepared.owner_epoch, prepared.manifest.digest, f.host, { selfTransfer: true });
  });
});

test('self-transfer refuses a checkout whose inode changed after preparation', async () => {
  const f = await claimed();
  driftDevice(f.root);
  await withEnv({ GBRAIN_HOME: f.home }, async () => {
    const prepared = await prepareWriterTransfer(engine, f.source, f.host, { selfTransfer: true });
    const old = join(f.base, 'old'); renameSync(f.root, old); cpSync(old, f.root, { recursive: true });
    await expect(acceptWriterTransfer(engine, f.source, f.root, prepared.owner_epoch, prepared.manifest.digest, f.host, { selfTransfer: true }))
      .rejects.toMatchObject({ code: 'recovery_required' });
  });
});

test('administration dry-run reports the drift and changes nothing', async () => {
  const f = await claimed();
  const staleDevice = driftDevice(f.root);
  const stampBefore = readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8');
  const result = await withEnv({ GBRAIN_HOME: f.home }, () =>
    runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: f.source, self_transfer: true, dry_run: true }));
  expect(result).toMatchObject({ dry_run: true, self_transfer: { device_recorded: staleDevice } });
  expect((await getWorktreeBinding(engine, f.source, f.host))!.state).toBe('active');
  expect(readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8')).toBe(stampBefore);
});

test('--self-transfer is an explicit boolean flag on both transfer phases', () => {
  expect(parsePersistenceAdminArgs('writer', ['transfer', 'prepare', 'default', '--self-transfer']).params)
    .toMatchObject({ source_id: 'default', self_transfer: true });
  expect(parsePersistenceAdminArgs('writer', ['transfer', 'accept', 'default', '--path', '/tmp/x', '--expected-epoch', '1',
    '--manifest', 'a'.repeat(64), '--self-transfer']).params).toMatchObject({ self_transfer: true });
  expect(() => parsePersistenceAdminArgs('writer', ['transfer', 'prepare', 'default', '--self-transfer=yes'])).toThrow();
});
