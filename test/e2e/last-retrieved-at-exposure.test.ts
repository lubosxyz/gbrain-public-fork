/**
 * v0.42.x — exposes `pages.last_retrieved_at` (migration v79, v0.37.0) on the
 * read-facing surfaces (`get_recent_salience`, `list_pages`, `get_page`) so
 * external consumers (e.g. `tools/gbrain-recall-metric` in the downstream agent
 * fleet repo) can auto-upgrade from a write/salience proxy to a real
 * verified-read signal.
 *
 * Runs against PGLite in-memory via `dispatchToolCall` (same path stdio/HTTP
 * MCP use). No DATABASE_URL, no API keys.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import {
  awaitPendingLastRetrievedWrites,
  _resetPendingLastRetrievedWritesForTests,
  _resetTrackRetrievalCacheForTests,
} from '../../src/core/last-retrieved.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  await engine.putPage('notes/never-read', {
    type: 'note',
    title: 'Never read',
    compiled_truth: 'This page is never surfaced by search/query/get_page.',
  });
  await engine.putPage('notes/will-be-read', {
    type: 'note',
    title: 'Will be read',
    compiled_truth: 'This page gets read via get_page to bump last_retrieved_at.',
  });
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

beforeEach(() => {
  _resetPendingLastRetrievedWritesForTests();
  _resetTrackRetrievalCacheForTests();
});

async function callTool(name: string, params: Record<string, unknown>) {
  const result = await dispatchToolCall(engine, name, params, { remote: false });
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

describe('last_retrieved_at exposure — get_recent_salience', () => {
  test('every row carries the key, null when never retrieved', async () => {
    const rows = await callTool('get_recent_salience', { days: 14, limit: 20 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toHaveProperty('last_retrieved_at');
    }
    const neverRead = rows.find((r: any) => r.slug === 'notes/never-read');
    expect(neverRead.last_retrieved_at).toBeNull();
  });

  test('reflects a bump caused by a prior get_page call', async () => {
    await callTool('get_page', { slug: 'notes/will-be-read' });
    // bumpLastRetrievedAt is fire-and-forget; drain before reading it back.
    await awaitPendingLastRetrievedWrites();

    const rows = await callTool('get_recent_salience', { days: 14, limit: 20 });
    const bumped = rows.find((r: any) => r.slug === 'notes/will-be-read');
    expect(bumped).toBeDefined();
    expect(bumped.last_retrieved_at).not.toBeNull();
    expect(new Date(bumped.last_retrieved_at).getTime()).not.toBeNaN();
  });
});

describe('last_retrieved_at exposure — list_pages', () => {
  test('whitelist includes last_retrieved_at (null by default)', async () => {
    const rows = await callTool('list_pages', { limit: 10 });
    const row = rows.find((r: any) => r.slug === 'notes/never-read');
    expect(row).toBeDefined();
    expect(row).toHaveProperty('last_retrieved_at');
    expect(row.last_retrieved_at).toBeNull();
  });

  test('list_pages does NOT itself bump last_retrieved_at (pure read)', async () => {
    await callTool('list_pages', { limit: 10 });
    await awaitPendingLastRetrievedWrites();
    const rows = await callTool('list_pages', { limit: 10 });
    const row = rows.find((r: any) => r.slug === 'notes/never-read');
    expect(row.last_retrieved_at).toBeNull();
  });
});

describe('last_retrieved_at exposure — get_page', () => {
  test('surfaces the value as of BEFORE this call\'s own bump (not a self-echo)', async () => {
    // First read: page has never been retrieved before, so the returned
    // value reflects that pre-call state (null) even though this very call
    // triggers a fire-and-forget bump for the NEXT read.
    const first = await callTool('get_page', { slug: 'notes/never-read' });
    expect(first).toHaveProperty('last_retrieved_at');
    expect(first.last_retrieved_at).toBeNull();

    await awaitPendingLastRetrievedWrites();

    // Second read: now reflects the bump caused by the first call.
    const second = await callTool('get_page', { slug: 'notes/never-read' });
    expect(second.last_retrieved_at).not.toBeNull();
  });
});
