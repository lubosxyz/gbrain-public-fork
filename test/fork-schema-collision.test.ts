import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

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
