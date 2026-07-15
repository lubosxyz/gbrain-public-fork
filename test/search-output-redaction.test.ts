import { describe, expect, test } from 'bun:test';

import { formatResult } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  redactCredentialLikeText,
  redactSearchResults,
} from '../src/core/search/output-redaction.ts';
import type { SearchResult } from '../src/core/types.ts';

const classicGithubToken = ['ghp', 'A'.repeat(36)].join('_');
const fineGrainedGithubToken = ['github', 'pat', 'B'.repeat(30), 'C'.repeat(30)].join('_');
const openAiToken = ['sk', 'proj', 'D'.repeat(48)].join('-');
const anthropicToken = ['sk', 'ant', 'api03', 'E'.repeat(48)].join('-');
const slackToken = ['xoxb', '123456789012', 'F'.repeat(28)].join('-');
const awsAccessKey = `AKIA${'G'.repeat(16)}`;
const googleApiKey = `AIza${'H'.repeat(35)}`;
const stripeLiveKey = `sk_live_${'I'.repeat(32)}`;
const jwt = [
  `eyJ${'J'.repeat(18)}`,
  `eyJ${'K'.repeat(24)}`,
  'L'.repeat(32),
].join('.');
const assignedSecret = `GITHUB_TOKEN=${'M'.repeat(32)}`;
const bearerSecret = `Authorization: Bearer ${'N'.repeat(32)}`;
const urlCredential = `https://user:${'P'.repeat(24)}@example.invalid/path`;
const pemKey = ['-----BEGIN PRIVATE KEY-----', 'Q'.repeat(80), '-----END PRIVATE KEY-----'].join('\n');
const sshPublicKey = `ssh-ed25519 ${'R'.repeat(68)} fixture-comment`;

function resultWith(text: string): SearchResult {
  return {
    slug: 'code/example',
    page_id: 1,
    title: `Credential evidence ${text}`,
    type: 'code',
    chunk_text: `before ${text} after`,
    chunk_source: 'compiled_truth',
    chunk_id: 2,
    chunk_index: 0,
    score: 0.9,
    stale: false,
    content_flag: { reason: 'fixture', detail: `found ${text}` },
    relational_path: ['code/source', text],
  };
}

describe('search output credential redaction', () => {
  test('redacts common credential shapes without printing the original value', () => {
    for (const credential of [
      classicGithubToken,
      fineGrainedGithubToken,
      openAiToken,
      anthropicToken,
      slackToken,
      awsAccessKey,
      googleApiKey,
      stripeLiveKey,
      jwt,
      assignedSecret,
      bearerSecret,
      urlCredential,
      pemKey,
      sshPublicKey,
    ]) {
      const output = redactCredentialLikeText(`prefix ${credential} suffix`);
      expect(output).not.toContain(credential);
      expect(output).toContain('<REDACTED:');
    }
  });

  test('does not redact ordinary hashes, identifiers, or short test labels', () => {
    const safe = [
      '5a0c1979cf439d434c527de4935687a178be4b8e',
      'a787412692c37ebb44eae5447967c568b0adc5b5',
      '550e8400-e29b-41d4-a716-446655440000',
      'ghp_test_fixture',
    ].join(' ');
    expect(redactCredentialLikeText(safe)).toBe(safe);
  });

  test('redacts every string-bearing search-result field without mutating input', () => {
    const original = resultWith(classicGithubToken);
    const [redacted] = redactSearchResults([original]);

    expect(JSON.stringify(redacted)).not.toContain(classicGithubToken);
    expect(JSON.stringify(redacted)).toContain('<REDACTED:github_token>');
    expect(original.chunk_text).toContain(classicGithubToken);
    expect(redacted).not.toBe(original);
  });

  test('CLI search formatting redacts a raw result defensively', () => {
    const output = formatResult('search', [resultWith(classicGithubToken)]);
    expect(output).not.toContain(classicGithubToken);
    expect(output).toContain('<REDACTED:github_token>');
  });

  test('search operation redacts before returning to CLI or MCP transports', async () => {
    const rawResult = resultWith(classicGithubToken);
    const engine = {
      getConfig: async (key: string) => key === 'search.mcp_keyword_only' ? 'true' : 'false',
      searchKeyword: async () => [rawResult],
      getContentFlagsByPageIds: async () => new Map(),
      executeRaw: async () => [],
    };
    const op = operationsByName.search;
    const returned = await op.handler({
      engine,
      config: {},
      remote: true,
      dryRun: false,
      sourceId: 'default',
      logger: console,
    } as never, { query: 'credential fixture' }) as SearchResult[];

    expect(JSON.stringify(returned)).not.toContain(classicGithubToken);
    expect(rawResult.chunk_text).toContain(classicGithubToken);
  });
});
