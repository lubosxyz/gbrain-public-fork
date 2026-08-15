/**
 * AI service error hierarchy. Three classes mapping to caller decisions:
 *
 *   AIConfigError     — user fixes: bad key, missing model, dim mismatch.
 *                       Abort + show recovery recipe.
 *   AITransientError  — retryable: SDK retries exhausted, rate limit sustained.
 *                       Propagate so job queue can retry later.
 *   AIServiceError    — base class for both.
 *
 * The `fix` field carries a human-readable recovery recipe agents and humans
 * can act on. The `cause` field preserves the underlying SDK error.
 */

export class AIServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export class AIConfigError extends AIServiceError {
  constructor(
    message: string,
    public readonly fix?: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'AIConfigError';
  }
}

export class AITransientError extends AIServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AITransientError';
  }
}

/**
 * A single input exceeded the model's context window. Permanent for THESE
 * bytes: no backoff, no smaller batch and no healthier provider can make the
 * same text fit, so the only forward moves are to shrink the input or to park
 * it. Kept a sibling of AIConfigError rather than a subclass because the
 * operator recovery differs — nothing about the key/model/dims is wrong, so
 * the run must skip this input and continue instead of aborting.
 */
export class AIInputTooLargeError extends AIServiceError {
  /** Marker for callers that branch on retryability without instanceof. */
  readonly permanent = true;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'AIInputTooLargeError';
  }
}

/**
 * Provider wordings for "this input is longer than the context window".
 *
 * Deliberately message-based: providers disagree on the status code for the
 * same condition (Ollama answers 5xx, OpenAI 400), so classifying by status
 * would put an identical, identically-permanent failure in two different
 * buckets. The batch-token-limit patterns in gateway's `isTokenLimitError`
 * are the sibling case — those say the BATCH was too big and shrinking it
 * helps; these say one input can never fit.
 */
const INPUT_TOO_LARGE_PATTERNS: RegExp[] = [
  // Ollama /v1/embeddings + llama.cpp server
  /input length exceeds the context length/i,
  /exceeds?(?: the)? maximum context length/i,
  /input is too large to process/i,
  /context length exceeded/i,
  // OpenAI: "...maximum context length is 8192 tokens... reduce the length"
  /maximum context length is \d+ tokens/i,
  /reduce the length of the (?:messages|input|prompt)/i,
  // Cohere / Voyage / ZeroEntropy input-length rejections
  /input must (?:be|have) (?:less|fewer) than \d+ tokens/i,
  /input exceeds (?:the )?(?:max|maximum) (?:token|length)/i,
];

/**
 * True when a provider message means "this single input is over the model's
 * context". Exported so the gateway can reuse the exact same judgment for its
 * batch-halving trigger — one pattern list, no drift between the layer that
 * splits and the layer that classifies.
 */
export function isInputTooLargeMessage(message: string): boolean {
  return INPUT_TOO_LARGE_PATTERNS.some((re) => re.test(message));
}

/** `isInputTooLargeMessage` over a thrown value of any shape. */
export function isInputTooLargeError(err: unknown): boolean {
  if (err instanceof AIInputTooLargeError) return true;
  return isInputTooLargeMessage(err instanceof Error ? err.message : String(err));
}

/**
 * Normalize any thrown error into our hierarchy. AI SDK errors are inspected
 * by status code + name; unknown errors default to AITransientError so the
 * caller does not permanently abort on a transient network blip.
 */
export function normalizeAIError(err: unknown, context?: string): AIServiceError {
  if (err instanceof AIServiceError) return err;

  const anyErr = err as { name?: string; status?: number; statusCode?: number; message?: string };
  const status = anyErr?.status ?? anyErr?.statusCode;
  const name = anyErr?.name ?? '';
  const msg = anyErr?.message ?? String(err);
  const ctxPrefix = context ? `[${context}] ` : '';

  // Checked BEFORE the status branches: an over-context input is permanent
  // whatever status the provider picked for it. Pre-fix, Ollama's 5xx-shaped
  // answer fell through to AITransientError and every caller retried bytes
  // that could never fit — the infinite-retry loop this class exists to end.
  if (isInputTooLargeMessage(msg)) {
    return new AIInputTooLargeError(`${ctxPrefix}${msg}`, err);
  }

  // 4xx (except 429) = config-level, non-retryable
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    return new AIConfigError(
      `${ctxPrefix}${msg}`,
      status === 401 || status === 403
        ? 'Check your API key is valid and has access to this model.'
        : 'Check your model id + provider options match the provider API.',
      err,
    );
  }

  // AI SDK named errors
  if (name === 'LoadAPIKeyError' || name === 'InvalidArgumentError') {
    return new AIConfigError(`${ctxPrefix}${msg}`, undefined, err);
  }

  // Everything else (5xx, timeouts, network) = transient
  return new AITransientError(`${ctxPrefix}${msg}`, err);
}
