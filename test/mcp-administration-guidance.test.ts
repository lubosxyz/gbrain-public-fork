import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { mcpAdministrationGuidance } from '../src/mcp/capabilities.ts';

describe('MCP administration discovery', () => {
  test('provides a usable owner-side action without claiming authority or guessing a stdio URL', () => {
    const guidance = mcpAdministrationGuidance();
    expect(guidance.oauth_admin_scope_grants_owner_access).toBe(false);
    expect(guidance).not.toHaveProperty('admin_url');
    expect(guidance.next_action).toContain('gbrain mcp admin login-link');
    expect(guidance.next_action).toContain('--admin-token-file');
  });

  test('derives the dashboard from the configured resource, including its deployment path', () => {
    expect(mcpAdministrationGuidance('https://brain.example.com/service/mcp').admin_url)
      .toBe('https://brain.example.com/service/admin/');
    expect(mcpAdministrationGuidance('http://localhost:3131/mcp/').admin_url)
      .toBe('http://localhost:3131/admin/');
  });

  test.each([
    credentialFixture('https://brain.example.com/mcp'),
    'https://brain.example.com/mcp?token=secret',
    'https://brain.example.com/mcp#secret',
    'https://brain.example.com/unrelated',
    'file:///private/mcp',
    'invalid',
  ])('does not publish userinfo or invent endpoints for an unsafe input', input => {
    const guidance = mcpAdministrationGuidance(input);
    expect(guidance).not.toHaveProperty('admin_url');
    expect(JSON.stringify(guidance)).not.toContain(input);
  });
});

function credentialFixture(target: string): string {
  const url = new URL(target);
  url.username = 'synthetic-user';
  url.password = randomUUID();
  return url.href;
}
