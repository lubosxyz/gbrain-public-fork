/**
 * KOM-287 — a chunk the embedder can never accept must be parked, not retried
 * forever.
 *
 * Production shape this reproduces (rejstrik/komfi/masiruyou replicas,
 * 2026-08-15 12:00:34 in ~/.gbrain/replica-refresh.log): three code pages each
 * held exactly one chunk longer than `ollama:bge-m3` will accept. The sync
 * pass isolated it and embedded the siblings, which left the page with ONE
 * stale chunk. The catch-up pass then hit `embedPageTexts`'s
 * `texts.length <= 1` bail — rethrow, count a failure, exit non-zero — and the
 * next run did the identical thing with the identical bytes. Six weeks of
 * twice-daily DEGRADED alerts, none of them actionable.
 *
 * The fix has two halves and both are pinned here:
 *   - the cheap half: a chunk over gbrain's own budget never reaches the
 *     provider at all;
 *   - the load-bearing half: when only the provider can tell (its tokenizer is
 *     not ours), its verdict is taken as final, recorded on the page, and not
 *     re-litigated.
 *
 * Serial: uses mock.module, which leaks across files sharing a bun process.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { AITransientError } from '../src/core/ai/errors.ts';

let embedCalls: string[][] = [];
let embedBatchBehavior: ((texts: string[], opts?: unknown) => Promise<Float32Array[]>) | null = null;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[], opts?: unknown) => {
    embedCalls.push([...texts]);
    if (embedBatchBehavior) return embedBatchBehavior(texts, opts);
    return texts.map(() => new Float32Array(1536));
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

// Import AFTER mocking.
const { runEmbedCore } = await import('../src/commands/embed.ts');

// Preflight seam: let diagnoseEmbedding's fast path pass without real env.
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  return new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop]) return overrides[prop];
      return track(prop);
    },
  });
}

/** The exact wording Ollama returned on the failing runs. */
const OVER_CONTEXT = 'the input length exceeds the context length';
const overContextError = () => new Error(OVER_CONTEXT);

/** Text past the default 2000-token pre-embed ceiling. */
const HUGE_CHUNK = 'alpha beta gamma delta epsilon '.repeat(2000);

function staleRows(slug: string, chunks: Array<{ chunk_index: number; chunk_text: string }>) {
  return chunks.map(c => ({
    slug, chunk_index: c.chunk_index, chunk_text: c.chunk_text,
    chunk_source: 'compiled_truth' as const, model: null, token_count: 1,
    source_id: 'default', page_id: 1,
  }));
}

function chunkRows(chunks: Array<{ chunk_index: number; chunk_text: string }>) {
  return chunks.map(c => ({
    chunk_index: c.chunk_index, chunk_text: c.chunk_text,
    chunk_source: 'compiled_truth' as const, embedded_at: null, token_count: 1,
  }));
}

beforeEach(() => {
  embedCalls = [];
  embedBatchBehavior = null;
  process.env.GBRAIN_EMBED_CONCURRENCY = '1';
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
});

describe('the provider verdict is taken as final', () => {
  test('--stale: siblings embed, the offender is parked, and the run stays green', async () => {
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good-a' },
      { chunk_index: 1, chunk_text: 'TOO-BIG' },
      { chunk_index: 2, chunk_text: 'good-b' },
    ];
    const upserts: Array<{ slug: string; chunks: any[] }> = [];
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => staleRows('poisoned-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async (slug: string, rows: any[]) => { upserts.push({ slug, chunks: rows }); },
    });

    const result = await runEmbedCore(engine, { stale: true });

    const byIdx = new Map(upserts[0].chunks.map((c: any) => [c.chunk_index, c]));
    expect(byIdx.get(0)!.embedding).toBeInstanceOf(Float32Array);
    expect(byIdx.get(2)!.embedding).toBeInstanceOf(Float32Array);
    expect(byIdx.get(1)!.embedding).toBeUndefined();
    expect(result.embedded).toBe(2);
    // The heart of the fix: an un-embeddable chunk is NOT a failure. Counting
    // it as one is what held the run's exit code red run after run.
    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
    expect(result.parked_samples[0]).toContain('poisoned-page');
  });

  test('--stale: the page is marked embed_skip so it leaves the rotation', async () => {
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [{ chunk_index: 0, chunk_text: 'ok' }, { chunk_index: 1, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('parked-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    await runEmbedCore(engine, { stale: true });

    const marks = (engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip');
    expect(marks).toHaveLength(1);
    expect(marks[0].args[0]).toBe('parked-page');
    expect(marks[0].args[1].marker.reason).toBe('chunk_token_limit');
    expect(marks[0].args[1].marker.bytes).toBe('TOO-BIG'.length);
    expect(typeof marks[0].args[1].marker.assessed_at).toBe('string');
  });

  test('--stale: a page left with ONE over-context chunk parks instead of failing', async () => {
    // The exact catch-up shape from the production log. Pre-fix this hit the
    // `texts.length <= 1` bail: rethrow → recordFailure → exit 1 → repeat
    // tomorrow, unchanged, forever.
    embedBatchBehavior = async () => { throw overContextError(); };
    const chunks = [{ chunk_index: 1, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => staleRows('catch-up-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
    expect(result.embedded).toBe(0);
    const marks = (engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip');
    expect(marks).toHaveLength(1);
  });

  test('--stale: a partly-parked page is not stamped as fully embedded', async () => {
    // Same reasoning as a partial failure (#3037): the page's chunks are not
    // all in the current embedding space, so claiming that provenance lies.
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [{ chunk_index: 0, chunk_text: 'ok' }, { chunk_index: 1, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('mixed-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    await runEmbedCore(engine, { stale: true });

    const calls = (engine as any)._calls as Array<{ method: string }>;
    expect(calls.filter(c => c.method === 'setPageEmbeddingSignature')).toHaveLength(0);
  });

  test('--all: the same verdict applies on the listPages path', async () => {
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.includes('TOO-BIG')) throw overContextError();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good-a' },
      { chunk_index: 1, chunk_text: 'TOO-BIG' },
    ];
    const engine = mockEngine({
      listPages: async () => [{ slug: 'all-path-page', source_id: 'default' }],
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { all: true });

    expect(result.embedded).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(1);
  });

  test('a failed marker write does not turn an otherwise clean run red', async () => {
    // Parking is an optimization on top of the local guard, not the guarantee.
    embedBatchBehavior = async () => { throw overContextError(); };
    const chunks = [{ chunk_index: 0, chunk_text: 'TOO-BIG' }];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => staleRows('unwritable-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
      markEmbedSkip: async () => { throw new Error('read-only replica'); },
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(0);
    expect(result.parked).toBe(1);
  });
});

describe('the local ceiling spends no provider call', () => {
  test('--stale: a chunk over the token cap never reaches the embedder', async () => {
    const chunks = [
      { chunk_index: 0, chunk_text: 'small' },
      { chunk_index: 1, chunk_text: HUGE_CHUNK },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('legacy-chunker-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    // Exactly one call, carrying only the small chunk. Pre-fix the oversized
    // text was sent, rejected, and re-sent on every subsequent run.
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(1);
    expect(embedCalls[0][0]).not.toContain(HUGE_CHUNK);
    expect(result.embedded).toBe(1);
    expect(result.parked).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.parked_samples[0]).toContain('exceeds the 2000-token embed input cap');
  });

  test('--stale: a page whose every chunk is over the cap spends no call at all', async () => {
    const chunks = [{ chunk_index: 0, chunk_text: HUGE_CHUNK }];
    const engine = mockEngine({
      countStaleChunks: async () => 1,
      listStaleChunks: async () => staleRows('all-oversized-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(embedCalls).toHaveLength(0);
    expect(result.parked).toBe(1);
    expect(result.failures).toBe(0);
  });
});

describe('retryable failures keep their existing treatment', () => {
  test('a transient outage is still a failure, not a parked chunk', async () => {
    // The whole point of the split: "come back later" must not be silenced
    // into "never again". A brain whose embedder was briefly down must still
    // re-embed those chunks on the next run.
    embedBatchBehavior = async () => { throw new AITransientError('upstream 502', { status: 502 }); };
    const chunks = [
      { chunk_index: 0, chunk_text: 'a' },
      { chunk_index: 1, chunk_text: 'b' },
      { chunk_index: 2, chunk_text: 'c' },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 3,
      listStaleChunks: async () => staleRows('outage-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(3);
    expect(result.parked).toBe(0);
    // Still no fan-out on a transient error (#3037 cost bounding).
    expect(embedCalls).toHaveLength(1);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(0);
  });

  test('a permanent request-shaped 400 still fans out and still counts as a failure', async () => {
    // Not every permanent error means "too long". A malformed input is a
    // failure the operator should see, and the page must not be parked.
    const bad400 = () => Object.assign(new Error('batch contains an invalid input'), { cause: { status: 400 } });
    embedBatchBehavior = async (texts: string[]) => {
      if (texts.length > 1 || texts[0] === 'BAD') throw bad400();
      return texts.map(() => new Float32Array(1536));
    };
    const chunks = [
      { chunk_index: 0, chunk_text: 'good' },
      { chunk_index: 1, chunk_text: 'BAD' },
    ];
    const engine = mockEngine({
      countStaleChunks: async () => 2,
      listStaleChunks: async () => staleRows('malformed-page', chunks),
      getChunks: async () => chunkRows(chunks),
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.failures).toBe(1);
    expect(result.parked).toBe(0);
    expect(result.embedded).toBe(1);
    expect((engine as any)._calls.filter((c: any) => c.method === 'markEmbedSkip')).toHaveLength(0);
  });
});
