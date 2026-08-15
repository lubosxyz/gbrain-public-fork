/**
 * KOM-287 — the pre-embed input ceiling.
 *
 * The embed path must not spend a provider call on a text that already
 * breaches gbrain's own chunk budget. Stored chunks carry no such guarantee:
 * rows written by an older chunker version survive the upgrade that
 * introduced the cap, and several paths recycle `chunk_text` verbatim.
 *
 * These tests pin the partition CONTRACT (order preservation, index mapping,
 * cap resolution). What they deliberately do not claim is that surviving the
 * guard means the provider will accept the text — see the module header for
 * the measurements showing a foreign tokenizer's verdict is not predictable
 * from a cl100k estimate.
 */
import { describe, test, expect } from 'bun:test';
import {
  EMBED_INPUT_TOKEN_CAP_ENV,
  describeOversizedInput,
  isEmbedInputOversized,
  maxEmbedInputTokens,
  partitionEmbedInputs,
} from '../src/core/embed-input-guard.ts';
import { DEFAULT_MAX_CHUNK_TOKENS, estimateEmbedTokens } from '../src/core/chunkers/token-estimate.ts';

/** Text comfortably over `cap` tokens: one token is at most a few chars. */
function overCap(cap: number): string {
  return 'alpha beta gamma delta '.repeat(cap);
}

describe('maxEmbedInputTokens', () => {
  test('defaults to the chunker budget so the guard restores an existing invariant', () => {
    expect(maxEmbedInputTokens({})).toBe(DEFAULT_MAX_CHUNK_TOKENS);
  });

  test('honors an operator override', () => {
    expect(maxEmbedInputTokens({ [EMBED_INPUT_TOKEN_CAP_ENV]: '512' })).toBe(512);
  });

  test('a malformed or non-positive override falls back rather than disabling the guard', () => {
    // Fail-safe: a typo in an env var must not silently turn the ceiling off.
    for (const bad of ['', 'lots', '0', '-1', 'NaN']) {
      expect(maxEmbedInputTokens({ [EMBED_INPUT_TOKEN_CAP_ENV]: bad })).toBe(DEFAULT_MAX_CHUNK_TOKENS);
    }
  });
});

describe('isEmbedInputOversized', () => {
  test('ordinary chunk text passes', () => {
    expect(isEmbedInputOversized('a modest paragraph of prose', 2000)).toBe(false);
  });

  test('empty text is never oversized', () => {
    expect(isEmbedInputOversized('', 2000)).toBe(false);
  });

  test('text past the cap is refused', () => {
    expect(isEmbedInputOversized(overCap(2000), 2000)).toBe(true);
  });
});

describe('partitionEmbedInputs', () => {
  test('an all-healthy batch is passed through untouched', () => {
    const texts = ['one', 'two', 'three'];
    const { sendable, sendableIndexes, oversized } = partitionEmbedInputs(texts, 2000);
    expect(sendable).toEqual(texts);
    expect(sendableIndexes).toEqual([0, 1, 2]);
    expect(oversized).toEqual([]);
  });

  test('index mapping survives a hole in the middle', () => {
    // The embed paths scatter results back onto chunk rows by index, so a
    // dropped input must not shift its siblings' identities.
    const big = overCap(200);
    const { sendable, sendableIndexes, oversized } = partitionEmbedInputs(
      ['keep-a', big, 'keep-b'],
      200,
    );
    expect(sendable).toEqual(['keep-a', 'keep-b']);
    expect(sendableIndexes).toEqual([0, 2]);
    expect(oversized).toHaveLength(1);
    expect(oversized[0].index).toBe(1);
    expect(oversized[0].chars).toBe(big.length);
    expect(oversized[0].estimatedTokens).toBeGreaterThan(200);
    expect(oversized[0].cap).toBe(200);
  });

  test('a batch where everything is oversized sends nothing', () => {
    const { sendable, oversized } = partitionEmbedInputs([overCap(100), overCap(100)], 100);
    expect(sendable).toEqual([]);
    expect(oversized).toHaveLength(2);
  });

  test('a multi-byte text under the cap in CHARACTERS is still caught', () => {
    // The fast path skips measurement on BYTE length, not character length.
    // A character test would be unsound in the direction that matters: emoji
    // and CJK are one or two JS string units but several tokens each, so
    // exactly the dense chunks this guard exists to catch would sail through.
    const cap = 200;
    const dense = '🎉漢字'.repeat(40); // comfortably under `cap` string units...
    expect(dense.length).toBeLessThan(cap);
    expect(estimateEmbedTokens(dense)).toBeGreaterThan(cap); // ...but not in tokens

    const { sendable, oversized } = partitionEmbedInputs([dense], cap);
    expect(sendable).toEqual([]);
    expect(oversized).toHaveLength(1);
  });

  test('short inputs are never measured (tiktoken is superlinear on long text)', () => {
    // A text shorter than `cap` CHARACTERS cannot exceed `cap` TOKENS, so the
    // estimator is skipped. Pinned because the cost of measuring every chunk
    // on a large corpus is what the fast path exists to avoid.
    const texts = Array.from({ length: 500 }, () => 'short chunk text');
    const started = Bun.nanoseconds();
    const { oversized } = partitionEmbedInputs(texts, 2000);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    expect(oversized).toEqual([]);
    expect(elapsedMs).toBeLessThan(50);
  });

  test('describeOversizedInput states both numbers and the ceiling in force', () => {
    const line = describeOversizedInput({ index: 0, chars: 9453, estimatedTokens: 2347, cap: 2000 });
    expect(line).toContain('9453');
    expect(line).toContain('2347');
    expect(line).toContain('2000');
  });
});
