import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

const WITHDRAWAL_TRIGGER = "SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'facts'::regclass AND tgname = 'facts_preserve_withdrawal'";
/** Upstream v264 made the INSERT side set-based; the per-row trigger fires on UPDATE only. */
const expectUpdateOnlyWithdrawalTrigger = async (engine: PGLiteEngine) => {
  const [row] = await engine.executeRaw<{ def: string }>(WITHDRAWAL_TRIGGER);
  expect(row?.def).toContain('BEFORE UPDATE OF');
  expect(row?.def).not.toContain('INSERT');
};

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('a fork v169 high-water mark repairs skipped prerequisites before v174 and preserves page identity', async () => {
    await engine.initSchema();
    const page = await engine.putPage('collision-seed', { title: 'Synthetic seed', type: 'note', compiled_truth: 'Preserve this synthetic page.' });
    const before = await engine.readPageSnapshot(page.slug, { sourceId: 'default' });
    // The historical fork's v166-169 did not install these upstream objects.
    await engine.executeRaw('ALTER TABLE fact_withdrawals DROP COLUMN subject CASCADE');
    await engine.executeRaw('ALTER TABLE fact_withdrawals ADD PRIMARY KEY(source_id,visibility,fact_hash)');
    await engine.executeRaw('ALTER TABLE facts DROP COLUMN embedding_model, DROP COLUMN embedded_text_hash');
    await engine.executeRaw('DROP TABLE dream_synthesis_completions');
    await engine.unsetConfig('fork.schema_prerequisites.v060');
    await engine.setConfig('version', '169');
    expect((await runMigrations(engine)).current).toBe(LATEST_VERSION);
    const after = await engine.readPageSnapshot(page.slug, { sourceId: 'default' });
    expect(after?.revision).toBe(before?.revision);
    expect(after?.page.id).toBe(before?.page.id);
    expect(after?.page.compiled_truth).toBe(before?.page.compiled_truth);
    expect(await engine.executeRaw('SELECT subject FROM fact_withdrawals LIMIT 1')).toEqual([]);
    expect(await engine.executeRaw('SELECT embedding_model,embedded_text_hash FROM facts LIMIT 1')).toEqual([]);
    expect(await engine.executeRaw('SELECT * FROM dream_synthesis_completions LIMIT 1')).toEqual([]);
    await expectUpdateOnlyWithdrawalTrigger(engine);
    expect(await runMigrations(engine)).toEqual({ applied: 0, current: LATEST_VERSION });
}, 120_000);

test('current fresh schema is unchanged by historical fork prerequisite repair', async () => {
 const engine = new PGLiteEngine(); await engine.connect({});
 try {
  await engine.initSchema();
  const before = await engine.executeRaw('SELECT key,value FROM config ORDER BY key');
  expect(await runMigrations(engine)).toEqual({applied:0,current:LATEST_VERSION});
  expect(await engine.executeRaw('SELECT key,value FROM config ORDER BY key')).toEqual(before);
 } finally { await engine.disconnect(); }
},120_000);

test('a fork brain stamped 244 by the old fork numbering gets the upstream v240-v244 DDL it skipped', async () => {
  const engine = new PGLiteEngine(); await engine.connect({});
  try {
    await engine.initSchema();
    const page = await engine.putPage('collision-seed-244', { title: 'Synthetic seed', type: 'note', compiled_truth: 'Preserve this synthetic page.' });
    const before = await engine.readPageSnapshot(page.slug, { sourceId: 'default' });
    // The fork's own v240-v244 replayed older upstream DDL; none of these upstream objects existed.
    await engine.executeRaw('DROP INDEX idx_pages_source_title_lower');
    await engine.executeRaw('DROP INDEX idx_pages_slug_trgm');
    await engine.executeRaw('DROP INDEX persistence_requests_slug_intent');
    await engine.executeRaw('ALTER TABLE extract_atoms_page_state DROP COLUMN partial_input_chars');
    await engine.executeRaw('ALTER TABLE extract_atoms_transcript_state DROP COLUMN partial_input_chars');
    await engine.executeRaw('ALTER TABLE persistence_consumers DROP COLUMN boot_id, DROP COLUMN process_start');
    await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN projected_byte_start, DROP COLUMN projected_byte_end');
    await engine.unsetConfig('fork.schema_prerequisites.v0604');
    await engine.setConfig('version', '244');
    expect((await runMigrations(engine)).current).toBe(LATEST_VERSION);
    const indexes = await engine.executeRaw<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_pages_source_title_lower','idx_pages_slug_trgm','persistence_requests_slug_intent') ORDER BY 1");
    expect(indexes.map(r => r.indexname)).toEqual(['idx_pages_slug_trgm', 'idx_pages_source_title_lower', 'persistence_requests_slug_intent']);
    expect(await engine.executeRaw('SELECT partial_input_chars FROM extract_atoms_page_state LIMIT 1')).toEqual([]);
    expect(await engine.executeRaw('SELECT partial_input_chars FROM extract_atoms_transcript_state LIMIT 1')).toEqual([]);
    expect(await engine.executeRaw('SELECT boot_id, process_start FROM persistence_consumers LIMIT 1')).toEqual([]);
    expect(await engine.executeRaw('SELECT projected_byte_start, projected_byte_end FROM content_chunks LIMIT 1')).toEqual([]);
    const after = await engine.readPageSnapshot(page.slug, { sourceId: 'default' });
    expect(after?.page.id).toBe(before?.page.id);
    expect(after?.page.compiled_truth).toBe(before?.page.compiled_truth);
    expect(await engine.getConfig('fork.schema_prerequisites.v0604')).toBe('complete');
    await expectUpdateOnlyWithdrawalTrigger(engine);
    expect(await runMigrations(engine)).toEqual({ applied: 0, current: LATEST_VERSION });
  } finally { await engine.disconnect(); }
}, 120_000);

describe('fork replay placeholders', () => {
  let fresh: PGLiteEngine;
  beforeAll(async () => { fresh = new PGLiteEngine(); await fresh.connect({}); await fresh.initSchema(); }, 120_000);
  afterAll(async () => { await fresh.disconnect(); });

  test('a fresh schema keeps the set-based fact insert guard after the fork placeholders', async () => {
    await expectUpdateOnlyWithdrawalTrigger(fresh);
  }, 120_000);

  test('a fork brain stamped 240 by the old fork numbering gets the old fork replays before newer upstream DDL', async () => {
    const page = await fresh.putPage('collision-seed-240', { title: 'Synthetic seed', type: 'note', compiled_truth: 'Preserve this synthetic page.' });
    // The old fork's v241 (upstream v166-v169 replay) had not run on a brain stamped 240.
    await fresh.executeRaw('ALTER TABLE facts DROP COLUMN embedding_model, DROP COLUMN embedded_text_hash');
    await fresh.executeRaw('DROP TABLE dream_synthesis_completions');
    await fresh.unsetConfig('fork.schema_prerequisites.v0604');
    await fresh.setConfig('version', '240');
    expect((await runMigrations(fresh)).current).toBe(LATEST_VERSION);
    expect(await fresh.executeRaw('SELECT embedding_model,embedded_text_hash FROM facts LIMIT 1')).toEqual([]);
    expect(await fresh.executeRaw('SELECT * FROM dream_synthesis_completions LIMIT 1')).toEqual([]);
    await expectUpdateOnlyWithdrawalTrigger(fresh);
    expect((await fresh.readPageSnapshot(page.slug, { sourceId: 'default' }))?.page.compiled_truth).toBe('Preserve this synthetic page.');
    expect(await fresh.getConfig('fork.schema_prerequisites.v0604')).toBe('complete');
    expect(await runMigrations(fresh)).toEqual({ applied: 0, current: LATEST_VERSION });
  }, 120_000);
});
