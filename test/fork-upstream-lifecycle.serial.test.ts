import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, activateManagedPersistence } from '../src/core/persistence/ownership.ts';
import { hasManagedRootMarker } from '../src/core/persistence/root-registry.ts';
import { physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { managedLintPublisher } from '../src/core/persistence/lint-publication.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveSyncPersistenceMode, withLegacySyncDelegation } from '../src/core/persistence/sync-authority.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-fork-lifecycle-')));
let engine: PGLiteEngine;
const embeddings = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith('/embeddings')) return new Response('Unexpected provider route', { status: 400 });
  const body = await request.json() as { input: string | string[] };
  const input = Array.isArray(body.input) ? body.input : [body.input];
  return Response.json({ object: 'list', data: input.map((_, index) => ({ object: 'embedding', index, embedding: Array(1536).fill(0.01) })), usage: { prompt_tokens: input.length, total_tokens: input.length } });
} });
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
});
afterAll(async () => { await engine.disconnect(); embeddings.stop(true); resetGateway(); rmSync(directory, { recursive: true, force: true }); });

async function fixture(name: string, managed: boolean) {
  const base = join(directory, name); const root = join(base, 'brain');
  mkdirSync(join(root, '.gbrain'), { recursive: true });
  const database = join(base, 'database');
  writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite', database_path: database,
    openai_api_key: 'synthetic-local-only', provider_base_urls: { openai: embeddings.url.href + 'v1' },
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
  }));
  writeFileSync(join(root, '.gitignore'), '.gbrain/\n.gbrain-owner.json\n.gbrain-managed\n');
  writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\ncaptured_at: 2026-01-01\n---\nA synthetic observation for the integration test.\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'Initial fixture');
  await withEnv({ GBRAIN_HOME: root }, async () => {
    await engine.connect({ database_path: database }); await engine.initSchema();
    await engine.setConfig('sync.repo_path', root);
    await engine.setConfig('schema_pack', 'gbrain-base');
    await engine.setConfig('search.mode', 'conservative');
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    const binding = await claimWorktree(engine, 'default', root);
    expect(binding.coordination_path?.startsWith(root + '/')).toBe(false);
    if (managed) await activateManagedPersistence(engine, { confirmQuiesced: true });
    expect((await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled).toBe(managed);
    await engine.disconnect();
  });
  const cli = async (args: string[]) => {
    const result = await runCli(args, { home: base, cwd: root, env: { GBRAIN_HOME: root }, timeoutMs: 120_000 });
    expect(result.stderr).not.toContain('belongs to a managed canonical worktree');
    expect(result.exitCode, result.stderr + '\n' + result.stdout).toBe(0);
    return result.stdout;
  };
  return { root, database, cli };
}

test('legacy sync accepts a disabled binding after both physical markers are absent', async () => {
  const { root, database, cli } = await fixture('legacy', false);
  const file = join(root, 'example.md');
  expect(hasManagedRootMarker(file)).toBe(true);
  renameSync(join(root, '.gbrain-owner.json'), join(directory, 'legacy-owner-preimage.json'));
  expect(hasManagedRootMarker(file)).toBe(true); // sibling reservation alone still fences
  renameSync(physicalRootReservationPath(root), join(directory, 'legacy-reservation-preimage.json'));
  expect(hasManagedRootMarker(file)).toBe(false);
  await withEnv({ GBRAIN_HOME: root }, async () => {
    await engine.connect({ database_path: database });
    await expect(withLegacySyncDelegation(() => resolveSyncPersistenceMode(engine, { sourceId: 'default' }))).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    for (const kind of ['github', 'google']) {
      await engine.executeRaw("UPDATE sources SET config=$1::jsonb WHERE id='default'", [JSON.stringify({ kind })]);
      await expect(resolveSyncPersistenceMode(engine, { sourceId: 'default' })).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    }
    await engine.executeRaw("UPDATE sources SET config='{}'::jsonb WHERE id='default'");
    expect(await engine.executeRaw("SELECT source_id FROM persistence_source_bindings WHERE source_id='default'")).toHaveLength(1);
    await engine.disconnect();
  });
  await cli(['sync', '--source', 'default', '--no-pull', '--no-embed']);
  const page = JSON.parse(await cli(['get', 'example', '--source', 'default', '--json']));
  expect(page.compiled_truth).toContain('synthetic observation');
  expect(existsSync(join(root, '.gbrain-owner.json'))).toBe(false);
  expect(existsSync(physicalRootReservationPath(root))).toBe(false);
}, 240_000);

test('managed sync, capture, session write and the nine supported dream phases survive CLI restarts', async () => {
  const { root, database, cli } = await fixture('managed', true);
  // Simulate APFS device drift, then exercise the explicit upstream recovery lane.
  const marker = join(root, '.gbrain-owner.json');
  const stamp = JSON.parse(readFileSync(marker, 'utf8'));
  stamp.device = String(BigInt(stamp.device) + 1n);
  writeFileSync(marker, JSON.stringify(stamp));
  const rejected = await runCli(['capture', 'Must remain blocked.', '--slug', 'notes/blocked', '--source', 'default', '--json'], { home: join(root, '..'), cwd: root, env: { GBRAIN_HOME: root }, timeoutMs: 30_000 });
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stdout + rejected.stderr).toMatch(/recovery_required|device identifier/);
  await withEnv({ GBRAIN_HOME: root }, async () => {
    await engine.connect({ database_path: database });
    const administer = async (op: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
      runPersistenceAdministration(engine, op, { ...params, ...await reviewedWriterIntent(engine, op) });
    const prepared = await administer('writer_transfer_prepare', { source_id: 'default', self_transfer: true }) as any;
    await administer('writer_transfer_accept', { source_id: 'default', path: root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    await engine.disconnect();
  });
  await cli(['sync', '--source', 'default', '--no-pull', '--no-embed']);
  await cli(['capture', 'A synthetic captured memory.', '--slug', 'notes/captured', '--source', 'default', '--json']);
  const session = '---\ntitle: Example Session\ntype: note\n---\nA synthetic session checkpoint.\n';
  const receipt = JSON.parse(await cli(['call', 'put_page', JSON.stringify({ slug: 'sessions/example', content: session, source_id: 'default' })]));
  expect(receipt.state).toBe('committed');
  const phases = ['lint', 'backlinks', 'sync', 'synthesize', 'extract', 'patterns', 'consolidate', 'embed', 'orphans'];
  const dream = JSON.parse(await cli(['dream', '--dir', root, ...phases.flatMap(phase => ['--phase', phase]), '--json']));
  expect(dream.phases.map((phase: { phase: string }) => phase.phase).sort()).toEqual([...phases].sort());
  expect(dream.phases.filter((phase: { status: string }) => phase.status === 'fail')).toEqual([]);
  console.log('FORK_LIFECYCLE_PHASES', dream.phases.map((phase: { phase: string; status: string }) => `${phase.phase}=${phase.status}`).join(' '));
  expect(JSON.parse(await cli(['get', 'notes/captured', '--source', 'default', '--json'])).compiled_truth).toContain('synthetic captured memory');
  expect(JSON.parse(await cli(['get', 'sessions/example', '--source', 'default', '--json'])).compiled_truth).toContain('synthetic session checkpoint');
  expect(readFileSync(join(root, 'sessions/example.md'), 'utf8')).toContain('synthetic session checkpoint');
  expect(readFileSync(join(root, 'example.md'), 'utf8')).toMatch(/^created:/m);
  await withEnv({ GBRAIN_HOME: root }, async () => {
    await engine.connect({ database_path: database });
    const prepare = await managedLintPublisher(engine, root);
    const first = await prepare(join(root, 'example.md'));
    const second = await prepare(join(root, 'example.md'));
    await second.publish(second.content + '\nA concurrent observation.\n');
    await expect(first.publish(first.content + '\nStale repair.\n')).rejects.toThrow();
    expect(readFileSync(join(root, 'example.md'), 'utf8')).toContain('A concurrent observation.');
    expect(readFileSync(join(root, 'example.md'), 'utf8')).not.toContain('Stale repair.');
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });
}, 240_000);
