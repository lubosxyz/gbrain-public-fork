/**
 * Regression: a vector search whose scope covers (almost) the whole brain was
 * planned as an exact scan over every chunk and hit the 8 s statement timeout.
 *
 * Root cause (EXPLAIN ANALYZE on a 158k-chunk Postgres brain, 2026-09-27): the
 * visibility predicate `text_projection_revision = knowledge_revision` is a
 * column-to-column equality the planner estimates at 0.5 % of pages (real:
 * 93 %). The planner therefore believed the scoped join yields ~70 pages,
 * started from `pages`, and computed the exact distance for ~150k chunks
 * (1.4M buffers, 14.6 s) instead of walking the HNSW index (~3–4k buffers).
 * A NARROW scope (the `default` source: 9 % of pages, ~1 % of chunks) is the
 * opposite case — there the exact plan is the right one and a forced HNSW scan
 * under-fills the candidate pool — so the fix routes by scope breadth.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  BROAD_SCOPE_PAGE_SHARE_DEFAULT,
  resolveBroadScopePageShare,
  scopePageShare,
  shouldForceAnnScan,
  SourcePageCountCache,
} from '../src/core/search/vector-scope-routing.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const COUNTS = new Map<string, number>([
  ['project-alpha-code', 8460],
  ['default', 1333],
  ['project-beta-code', 1093],
  ['project-gamma-code', 866],
]);
const ALL = [...COUNTS.keys()];

afterEach(() => {
  delete process.env.GBRAIN_VECTOR_FORCE_ANN;
  delete process.env.GBRAIN_VECTOR_FORCE_ANN_SHARE;
});

describe('scopePageShare', () => {
  test('an unscoped search covers the whole brain', () => {
    expect(scopePageShare(COUNTS, {})).toBe(1);
  });

  test('a single narrow source is its page share', () => {
    expect(scopePageShare(COUNTS, { sourceId: 'default' })).toBeCloseTo(1333 / 11752, 5);
  });

  test('a federated source list sums its members; the array wins over the scalar', () => {
    expect(scopePageShare(COUNTS, { sourceIds: ALL, sourceId: 'default' })).toBe(1);
  });

  test('unknown sources contribute nothing', () => {
    expect(scopePageShare(COUNTS, { sourceId: 'nope' })).toBe(0);
  });

  test('an empty or unknown count map is treated as unknown (0), never as broad', () => {
    expect(scopePageShare(new Map(), {})).toBe(0);
    expect(scopePageShare(null, {})).toBe(0);
  });
});

describe('shouldForceAnnScan', () => {
  const base = { hnswIndexed: true };

  test('forces the HNSW-ordered scan for a whole-brain federated scope', () => {
    expect(shouldForceAnnScan(COUNTS, { sourceIds: ALL }, base)).toBe(true);
    expect(shouldForceAnnScan(COUNTS, {}, base)).toBe(true);
  });

  test('leaves a narrow scope to the exact plan', () => {
    expect(shouldForceAnnScan(COUNTS, { sourceId: 'default' }, base)).toBe(false);
  });

  test('never forces without an HNSW index on the searched column', () => {
    expect(shouldForceAnnScan(COUNTS, { sourceIds: ALL }, { hnswIndexed: false })).toBe(false);
  });

  test.each([
    ['type', { type: 'person' }],
    ['types', { types: ['person'] }],
    ['language', { language: 'typescript' }],
    ['symbolKind', { symbolKind: 'function' }],
    ['afterDate', { afterDate: '2026-01-01' }],
    ['beforeDate', { beforeDate: '2026-01-01' }],
    ['detail low', { detail: 'low' }],
  ])('a selective %s filter keeps the planner in charge', (_label, extra) => {
    expect(shouldForceAnnScan(COUNTS, { sourceIds: ALL, ...(extra as object) }, base)).toBe(false);
  });

  test('unknown page counts keep the current planner behaviour', () => {
    expect(shouldForceAnnScan(null, { sourceIds: ALL }, base)).toBe(false);
  });

  test('GBRAIN_VECTOR_FORCE_ANN=off is a kill switch', () => {
    process.env.GBRAIN_VECTOR_FORCE_ANN = 'off';
    expect(shouldForceAnnScan(COUNTS, { sourceIds: ALL }, base)).toBe(false);
  });
});

describe('resolveBroadScopePageShare', () => {
  test('defaults to a conservative near-whole-brain share', () => {
    expect(resolveBroadScopePageShare()).toBe(BROAD_SCOPE_PAGE_SHARE_DEFAULT);
    expect(BROAD_SCOPE_PAGE_SHARE_DEFAULT).toBeGreaterThanOrEqual(0.8);
  });

  test('accepts an override in (0, 1] and ignores garbage', () => {
    process.env.GBRAIN_VECTOR_FORCE_ANN_SHARE = '0.6';
    expect(resolveBroadScopePageShare()).toBe(0.6);
    process.env.GBRAIN_VECTOR_FORCE_ANN_SHARE = 'abc';
    expect(resolveBroadScopePageShare()).toBe(BROAD_SCOPE_PAGE_SHARE_DEFAULT);
    process.env.GBRAIN_VECTOR_FORCE_ANN_SHARE = '0';
    expect(resolveBroadScopePageShare()).toBe(BROAD_SCOPE_PAGE_SHARE_DEFAULT);
    process.env.GBRAIN_VECTOR_FORCE_ANN_SHARE = '1.5';
    expect(resolveBroadScopePageShare()).toBe(BROAD_SCOPE_PAGE_SHARE_DEFAULT);
  });
});

describe('SourcePageCountCache', () => {
  test('loads once within the TTL and reloads after it', async () => {
    let now = 1_000;
    let loads = 0;
    const cache = new SourcePageCountCache(60_000, () => now);
    const loader = async () => { loads++; return COUNTS; };
    expect(await cache.get(loader)).toBe(COUNTS);
    expect(await cache.get(loader)).toBe(COUNTS);
    expect(loads).toBe(1);
    now += 60_001;
    await cache.get(loader);
    expect(loads).toBe(2);
  });

  test('a failing loader yields null (unknown) and is retried next time', async () => {
    const cache = new SourcePageCountCache(60_000, () => 0);
    expect(await cache.get(async () => { throw new Error('db down'); })).toBeNull();
    expect(await cache.get(async () => COUNTS)).toBe(COUNTS);
  });
});

describe('PostgresEngine.searchVector routes by scope breadth', () => {
  /** Run searchVector against a stubbed transaction and return the statements it issued. */
  async function statementsFor(opts: Record<string, unknown>): Promise<string[]> {
    const engine = new PostgresEngine() as any;
    const seen: string[] = [];
    engine.executeRaw = async () => [{ extversion: '0.8.0' }];
    engine.loadSourcePageCounts = async () => COUNTS;
    engine.withScopedReadTransaction = async (_ids: unknown, _id: unknown, cb: (tx: unknown) => unknown) => {
      const tx: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
        seen.push(strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''));
        return Promise.resolve([{ statement_timeout: '0' }]);
      };
      tx.unsafe = (sql: string) => Promise.resolve(sql.includes('count(*)::int AS eligible') ? [{ eligible: 0 }] : []);
      return cb(tx);
    };
    await engine.searchVector(new Float32Array(8), { limit: 5, ...opts });
    return seen;
  }

  test('a whole-brain federated scope disables the explicit sort so the HNSW order is used', async () => {
    const seen = await statementsFor({ sourceIds: ALL });
    expect(seen.some((s) => /SET LOCAL enable_sort = off/.test(s))).toBe(true);
  });

  test('a narrow scope keeps the planner-chosen exact plan', async () => {
    const seen = await statementsFor({ sourceId: 'default' });
    expect(seen.some((s) => /enable_sort/.test(s))).toBe(false);
  });

  test('a selective type filter keeps the planner-chosen plan', async () => {
    const seen = await statementsFor({ sourceIds: ALL, types: ['person'] });
    expect(seen.some((s) => /enable_sort/.test(s))).toBe(false);
  });
});
