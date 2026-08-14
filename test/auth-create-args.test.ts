import { test, expect, describe } from 'bun:test';
import { parseAuthCreateArgs, parseAuthClientsArgs, parseRescopeSurfaceValue } from '../src/commands/auth.ts';

describe('parseAuthCreateArgs', () => {
  test('bare name (no flag) resolves the name — regression for the dropped-name bug', () => {
    // Pre-fix this returned name='' because rest[takesIdx+1] === rest[0] when
    // takesIdx === -1, excluding the only positional from the search.
    expect(parseAuthCreateArgs(['claude-code'])).toEqual({ name: 'claude-code', takesHolders: undefined });
  });

  test('name + --takes-holders', () => {
    expect(parseAuthCreateArgs(['claude-code', '--takes-holders', 'world,garry'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world', 'garry'],
    });
  });

  test('--takes-holders before the name still finds the name', () => {
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'claude-code'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world'],
    });
  });

  test('the takes-holders value is not mistaken for the name', () => {
    // 'world' is the flag value, 'mybot' is the name.
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'mybot']).name).toBe('mybot');
  });

  test('no name → empty string (caller prints usage)', () => {
    expect(parseAuthCreateArgs([]).name).toBe('');
    expect(parseAuthCreateArgs(['--takes-holders', 'world']).name).toBe('');
  });

  test('takes-holders trims + drops empties', () => {
    expect(parseAuthCreateArgs(['n', '--takes-holders', ' world , , garry ']).takesHolders).toEqual(['world', 'garry']);
  });
});

// WP4: `auth rescope-client --surface` value parsing. 'clear' → null (clears
// the pin), the three known surfaces pass through, anything else → undefined
// (caller errors with usage).
describe('parseRescopeSurfaceValue (WP4)', () => {
  test('known surfaces pass through', () => {
    expect(parseRescopeSurfaceValue('verbs')).toBe('verbs');
    expect(parseRescopeSurfaceValue('starter')).toBe('starter');
    expect(parseRescopeSurfaceValue('full')).toBe('full');
  });

  test("'clear' → null (removes the operator pin)", () => {
    expect(parseRescopeSurfaceValue('clear')).toBe(null);
  });

  test('anything else → undefined (loud CLI error)', () => {
    expect(parseRescopeSurfaceValue('everything')).toBeUndefined();
    expect(parseRescopeSurfaceValue('')).toBeUndefined();
    expect(parseRescopeSurfaceValue('none')).toBeUndefined();
  });
});

// E4 (WP4): `auth clients [--usage] [--days N] [--json]` flag parsing.
describe('parseAuthClientsArgs (E4)', () => {
  test('defaults: no usage join, 30d window, human output', () => {
    expect(parseAuthClientsArgs([])).toEqual({ usage: false, days: 30, json: false });
  });

  test('--usage and --json flags, in any order', () => {
    expect(parseAuthClientsArgs(['--usage', '--json'])).toEqual({ usage: true, days: 30, json: true });
    expect(parseAuthClientsArgs(['--json', '--usage'])).toEqual({ usage: true, days: 30, json: true });
  });

  test('--days accepts integers in [1, 3650]', () => {
    expect(parseAuthClientsArgs(['--days', '1']).days).toBe(1);
    expect(parseAuthClientsArgs(['--days', '90']).days).toBe(90);
    expect(parseAuthClientsArgs(['--days', '3650']).days).toBe(3650);
  });

  test('--days rejects out-of-bounds and non-integer values loudly', () => {
    expect(() => parseAuthClientsArgs(['--days', '0'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days', '3651'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days', '1.5'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days', 'soon'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days'])).toThrow(/--days/);
  });

  test('unknown flags reject loudly', () => {
    expect(() => parseAuthClientsArgs(['--nope'])).toThrow(/Unknown flag/);
  });
});
