/**
 * KOM-287 — telling a PERMANENT over-context input apart from a transient
 * provider problem.
 *
 * The bug: Ollama answers "the input length exceeds the context length" with a
 * non-4xx shape, so `normalizeAIError` filed it under AITransientError — the
 * bucket whose whole meaning is "try again later". Every layer above then did
 * exactly that, forever: `gbrain embed` re-sent identical bytes on every run,
 * the run exited non-zero every time, and the replica watchdog reported the
 * same brain DEGRADED twice a day until the alert became noise.
 *
 * Two things are pinned here:
 *   1. Classification is by MESSAGE, not status. Providers disagree on the
 *      status for this one condition (Ollama 5xx-shaped, OpenAI 400), so a
 *      status-based rule would file an identical, identically-permanent
 *      failure in two different buckets.
 *   2. The gateway isolates the offending input by halving the batch — but
 *      does NOT shrink the recipe's batch safety factor while doing so. Batch
 *      size was never the problem; shrinking would throttle every later batch
 *      on account of one bad chunk.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  isTokenLimitError,
  __setEmbedTransportForTests,
  __getShrinkStateForTests,
} from '../../src/core/ai/gateway.ts';
import {
  AIConfigError,
  AIInputTooLargeError,
  AITransientError,
  isInputTooLargeError,
  isInputTooLargeMessage,
  normalizeAIError,
} from '../../src/core/ai/errors.ts';
import { classifyErrorCode } from '../../src/core/sync-failure-ledger.ts';

// Sibling files share a bun process; a configured gateway with a real
// transport would make the next file's first embed a live HTTP call.
afterAll(() => resetGateway());

/** The exact wording from the 2026-08-15 replica-refresh log. */
const OLLAMA_MESSAGE = 'the input length exceeds the context length';

describe('normalizeAIError classifies over-context input as permanent', () => {
  test('the Ollama wording is AIInputTooLargeError, not transient', () => {
    // Pre-fix this landed on AITransientError, which is what armed the
    // unbounded retry.
    const out = normalizeAIError(new Error(OLLAMA_MESSAGE), 'embed(ollama:bge-m3)');
    expect(out).toBeInstanceOf(AIInputTooLargeError);
    expect(out).not.toBeInstanceOf(AITransientError);
    expect((out as AIInputTooLargeError).permanent).toBe(true);
    expect(out.message).toBe('[embed(ollama:bge-m3)] the input length exceeds the context length');
  });

  test('the same wording behind a 400 does not become a config error', () => {
    // OpenAI returns 400 for an over-long input. "Check your model id" is the
    // wrong recovery: the credentials and model are fine, one input is not.
    const err = Object.assign(
      new Error("This model's maximum context length is 8192 tokens, however you requested 9000."),
      { status: 400 },
    );
    const out = normalizeAIError(err);
    expect(out).toBeInstanceOf(AIInputTooLargeError);
    expect(out).not.toBeInstanceOf(AIConfigError);
  });

  test('the same wording behind a 500 does not become transient', () => {
    const err = Object.assign(new Error(OLLAMA_MESSAGE), { status: 500 });
    expect(normalizeAIError(err)).toBeInstanceOf(AIInputTooLargeError);
  });

  test('unrelated failures keep their existing classification', () => {
    expect(normalizeAIError(new Error('socket hang up'))).toBeInstanceOf(AITransientError);
    expect(
      normalizeAIError(Object.assign(new Error('invalid api key'), { status: 401 })),
    ).toBeInstanceOf(AIConfigError);
    expect(
      normalizeAIError(Object.assign(new Error('upstream is on fire'), { status: 502 })),
    ).toBeInstanceOf(AITransientError);
  });

  test('an already-normalized error passes through untouched', () => {
    const original = new AIInputTooLargeError('already classified');
    expect(normalizeAIError(original)).toBe(original);
  });
});

describe('isInputTooLargeMessage covers the wordings actually seen in the wild', () => {
  test.each([
    ['ollama / llama.cpp', OLLAMA_MESSAGE],
    ['openai', "This model's maximum context length is 8192 tokens, however you requested 9000 tokens."],
    ['openai tail', 'Please reduce the length of the input and try again.'],
    ['llama.cpp', 'the input is too large to process. increase the physical batch size'],
    ['vllm', 'context length exceeded for this request'],
    ['cohere-style', 'input must have less than 512 tokens'],
  ])('%s', (_provider, message) => {
    expect(isInputTooLargeMessage(message)).toBe(true);
  });

  test.each([
    ['rate limit', 'Rate limit reached. Please try again in 248ms.'],
    ['network', 'fetch failed: ECONNREFUSED'],
    ['auth', 'Incorrect API key provided'],
    // The sibling case: the BATCH was too big. Shrinking it helps, so this
    // must NOT be classified as a permanently un-embeddable input.
    ['batch token limit', 'The max allowed tokens per submitted batch is 120000.'],
  ])('does not match %s', (_kind, message) => {
    expect(isInputTooLargeMessage(message)).toBe(false);
  });

  test('isInputTooLargeError accepts thrown values of any shape', () => {
    expect(isInputTooLargeError(new Error(OLLAMA_MESSAGE))).toBe(true);
    expect(isInputTooLargeError(OLLAMA_MESSAGE)).toBe(true);
    expect(isInputTooLargeError(new AIInputTooLargeError('x'))).toBe(true);
    expect(isInputTooLargeError(new Error('socket hang up'))).toBe(false);
  });

  test('isTokenLimitError stays scoped to batch-shaped limits', () => {
    // The two judgments must stay distinct: one says "send a smaller batch",
    // the other says "this input can never fit".
    expect(isTokenLimitError(new Error('The max allowed tokens per submitted batch is 120000.'))).toBe(true);
    expect(isTokenLimitError(new Error(OLLAMA_MESSAGE))).toBe(false);
  });
});

describe('the strict predicate agrees with the sync-failure ledger', () => {
  // gbrain already had a name for this condition — `EMBEDDING_OVERSIZE` in
  // sync-failure-ledger.ts — it just never acted on it. The two lists stay
  // separate on purpose (see the comment at that call site: one drives
  // behavior and must be narrow, the other labels a report and can be broad),
  // but they must not DISAGREE: anything the embed path parks has to show up
  // in the ledger under the code that describes it, not as UNKNOWN.
  test.each([
    OLLAMA_MESSAGE,
    "This model's maximum context length is 8192 tokens, however you requested 9000 tokens.",
    'Please reduce the length of the input and try again.',
    'the input is too large to process. increase the physical batch size',
    'context length exceeded for this request',
    'input must have less than 512 tokens',
  ])('%s → EMBEDDING_OVERSIZE', (message) => {
    expect(isInputTooLargeMessage(message)).toBe(true);
    expect(classifyErrorCode(message)).toBe('EMBEDDING_OVERSIZE');
  });

  test('the ledger keeps classifying what it already did', () => {
    // The strict predicate was OR'd IN, never substituted — these wordings
    // match only the pre-existing regex and must still land in the bucket.
    for (const message of ['input too long for this model', 'request had too many tokens']) {
      expect(isInputTooLargeMessage(message)).toBe(false);
      expect(classifyErrorCode(message)).toBe('EMBEDDING_OVERSIZE');
    }
  });

  test('a rate limit still outranks it', () => {
    // Ordering inside classifyErrorCode matters: the rate-limit branch comes
    // first, and a 429 is retryable however its message reads.
    expect(classifyErrorCode('Rate limit reached. Please try again in 248ms.')).toBe('EMBEDDING_RATE_LIMIT');
  });
});

describe('gateway isolates an over-context input by halving the batch', () => {
  beforeEach(() => {
    resetGateway();
    configureGateway({
      embedding_model: 'ollama:bge-m3',
      embedding_dimensions: 1024,
      env: {},
    });
  });

  test('one poisoned text no longer darkens its whole batch', async () => {
    // Pre-fix: Ollama's wording matched no halving pattern, so the single
    // embedMany call for all four texts threw and every sibling stayed NULL.
    const seen: string[][] = [];
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      seen.push([...values]);
      if (values.includes('POISON')) throw new Error(OLLAMA_MESSAGE);
      return { embeddings: values.map(() => Array.from({ length: 1024 }, () => 0.1)) };
    }) as any);

    await expect(embed(['a', 'POISON', 'b', 'c'])).rejects.toBeInstanceOf(AIInputTooLargeError);

    // It halved down to the single offender rather than giving up on the batch.
    expect(seen.some(batch => batch.length === 1 && batch[0] === 'POISON')).toBe(true);
    // And the halves not containing it were actually embedded.
    expect(seen.some(batch => batch.length > 0 && !batch.includes('POISON'))).toBe(true);
  });

  test('isolating one bad input does not shrink the recipe batch budget', () => {
    // shrinkOnMiss exists for batch-shaped limits. Firing it here would make
    // one un-embeddable chunk throttle every later batch in the process.
    expect(__getShrinkStateForTests('ollama')).toBeUndefined();
  });

  test('a single over-context text is reported permanently, not retried', async () => {
    __setEmbedTransportForTests((async () => { throw new Error(OLLAMA_MESSAGE); }) as any);
    await expect(embed(['only-one'])).rejects.toBeInstanceOf(AIInputTooLargeError);
  });
});
