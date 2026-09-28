/**
 * Output-boundary credential redaction for search and query results.
 *
 * Code repositories and transcripts legitimately contain credential-shaped
 * test fixtures. Retrieval must treat those bytes as sensitive anyway: an
 * agent cannot tell a synthetic fixture from a live key after the value has
 * already reached its transcript. Ranking still uses the original indexed
 * text; only the value returned by CLI/MCP transports is copied and scrubbed.
 */

import type { SearchResult } from '../types.ts';

interface CredentialPattern {
  kind: string;
  pattern: RegExp;
}

const CREDENTIAL_PATTERNS: ReadonlyArray<CredentialPattern> = [
  { kind: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'github_fine_grained_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'gitlab_token', pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/g },
  { kind: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,255}\b/g },
  { kind: 'openai_api_key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/g },
  { kind: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/g },
  { kind: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: 'stripe_live_key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,255}\b/g },
  { kind: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'huggingface_token', pattern: /\bhf_[A-Za-z0-9]{30,255}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer_token', pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{16,255}\b/gi },
  {
    kind: 'pem_key_material',
    pattern: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PUBLIC KEY|CERTIFICATE|PGP PUBLIC KEY BLOCK|PGP PRIVATE KEY BLOCK)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|PUBLIC KEY|CERTIFICATE|PGP PUBLIC KEY BLOCK|PGP PRIVATE KEY BLOCK)-----/g,
  },
  {
    kind: 'ssh_public_key',
    pattern: /\b(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]{40,}(?:[ \t]+[^\r\n]*)?/g,
  },
  {
    kind: 'assigned_secret',
    pattern: /["']?\b(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)|token|secret|password|api[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,255}["']?/gi,
  },
  { kind: 'url_credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/gi },
];

export function redactCredentialLikeText(text: string): string {
  if (text.length === 0) return text;
  if (text.length > OUTPUT_REDACTION_MAX_FIELD_CHARS) return OUTPUT_REDACTION_LIMIT;
  let redacted = text;
  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, `<REDACTED:${kind}>`);
  }
  return redacted;
}

function redactValue<T>(value: T, budget: { remaining: number; fields: number }, depth = 0): T {
  if (depth > MAX_DEPTH) return OUTPUT_REDACTION_LIMIT as T;
  if (typeof value === 'string') {
    if (value.length > budget.remaining || ++budget.fields > MAX_TEXT_FIELDS) return OUTPUT_REDACTION_LIMIT as T;
    budget.remaining -= value.length;
    return redactCredentialLikeText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, budget, depth + 1)) as T;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(output, key, { value: redactValue(entry, budget, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return output as T;
  }
  return value;
}

/** Return a redacted copy. Never mutate engine-owned result objects. */
export function redactSearchResults(results: readonly SearchResult[]): SearchResult[] {
  const budget = { remaining: OUTPUT_REDACTION_MAX_TOTAL_CHARS, fields: 0 };
  return results.map((result) => redactValue(result, budget));
}

export function credentialRedactionKinds(): readonly string[] {
  return CREDENTIAL_PATTERNS.map(({ kind }) => kind);
}

import { applyRedaction, planRedaction, type RedactionPlan } from '../secret-scan.ts';
import { DEGRADED_REASONS, DEGRADED_STAGES } from '../types.ts';

export const OUTPUT_REDACTION_MAX_FIELD_CHARS = 64 * 1024;
export const OUTPUT_REDACTION_MAX_TOTAL_CHARS = 1024 * 1024;
export const OUTPUT_REDACTION_LIMIT = '<REDACTED:output_limit>';

const IDENTITY_FIELDS = new Set([
  'id', 'slug', 'source_id', 'page_id', 'chunk_id', 'message_id', 'thread_id',
  'graph_session_prefix', 'relational_seed', 'relational_path', 'superseded_by',
]);
const MAX_DEPTH = 24;
const MAX_TEXT_FIELDS = 8192;
const DEGRADED_STAGE_CODES = new Set<string>(DEGRADED_STAGES);
const DEGRADED_REASON_CODES = new Set<string>(DEGRADED_REASONS);

export function redactRetrievalOutput<T, M>(results: T[], meta: M): { results: T[]; meta: M } {
  const echoValues = new Map<string, string>();
  const plans = new Map<string, RedactionPlan>();
  const writes: Array<() => void> = [];
  let remaining = OUTPUT_REDACTION_MAX_TOTAL_CHARS;
  let fields = 0;

  function copy(value: unknown, depth: number, path: Array<string | number>): unknown {
    if (typeof value !== 'object' || value === null) return value;
    if (depth > MAX_DEPTH) return OUTPUT_REDACTION_LIMIT;
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const [key, item] of entries) {
      let next: unknown;
      if (IDENTITY_FIELDS.has(String(key)) && (typeof item !== 'object' || item === null ||
        (Array.isArray(item) && item.every(part => typeof part === 'string')))) {
        next = Array.isArray(item) ? [...item] : item;
      } else if (typeof item === 'string' && path[0] === 'meta' && (
        path.length === 3 && path[1] === 'degraded' && typeof path[2] === 'number' &&
          (key === 'stage' && DEGRADED_STAGE_CODES.has(item) || key === 'reason' && DEGRADED_REASON_CODES.has(item)) ||
        path.length === 2 && path[1] === 'projection_readiness' && key === 'status' &&
          ['ready', 'projection_pending', 'unknown'].includes(item)
      )) {
        next = item;
      } else if (typeof item === 'string') {
        let plan = plans.get(item);
        if (item.length > OUTPUT_REDACTION_MAX_FIELD_CHARS || item.length > remaining || ++fields > MAX_TEXT_FIELDS) {
          next = OUTPUT_REDACTION_LIMIT;
        } else {
          remaining -= item.length;
          if (!plan) {
            plan = planRedaction(item, { echoValues });
            plans.set(item, plan);
          }
          const planned = plan;
          writes.push(() => {
            Object.defineProperty(out, key, { value: applyRedaction(planned), enumerable: true, writable: true, configurable: true });
          });
        }
      } else {
        next = copy(item, depth + 1, [...path, key]);
      }
      Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  const output = copy({ results, meta }, 0, []) as { results: T[]; meta: M };
  for (const write of writes) write();
  return output;
}
