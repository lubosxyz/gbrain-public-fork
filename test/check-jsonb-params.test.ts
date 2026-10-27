/**
 * Self-test for scripts/check-jsonb-params.mjs — the positional jsonb
 * double-encode guard (#2339 / #2324 class). Verifies it catches the bug shape
 * (including generic-typed calls and the `jsonStr` variable case is acknowledged
 * as out of scope) and does NOT false-positive on the sanctioned forms.
 *
 * Fixtures are written to a temp dir and the scanner is pointed at it via argv,
 * so this never touches the real src/ tree.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-jsonb-params.mjs');

let root: string;
let badDir: string;
let goodDir: string;

function runGuard(dir: string): { code: number; err: string } {
  const res = Bun.spawnSync([process.execPath, SCRIPT, dir]);
  return { code: res.exitCode, err: res.stderr.toString() + res.stdout.toString() };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jsonb-guard-'));
  badDir = join(root, 'bad');
  goodDir = join(root, 'good');
  mkdirSync(badDir, { recursive: true });
  mkdirSync(goodDir, { recursive: true });

  // BAD: positional $1::jsonb bound to a JSON.stringify'd value.
  writeFileSync(
    join(badDir, 'bad.ts'),
    "await engine.executeRaw(`INSERT INTO t (a) VALUES ($1::jsonb)`, [JSON.stringify(x)]);\n",
  );
  // BAD: generic-typed executeRaw<T>(...) must still be caught.
  writeFileSync(
    join(badDir, 'bad_generic.ts'),
    "await engine.executeRaw<{ id: string }>(`UPDATE t SET a = $2::jsonb WHERE id = $1`, [id, JSON.stringify(x)]);\n",
  );
  // BAD: template interpolation with an object-literal argument (the
  // markEmbedSkip regression the grep in check-jsonb-pattern.sh could not see).
  writeFileSync(
    join(badDir, 'bad_tpl_object.ts'),
    "await exec.run(sqlFragment`UPDATE pages SET frontmatter = frontmatter || ${JSON.stringify({ [KEY]: marker })}::jsonb WHERE slug = ${slug}`);\n",
  );
  // BAD: template interpolation with a nested call argument.
  writeFileSync(
    join(badDir, 'bad_tpl_nested.ts'),
    "await exec.run(sqlFragment`UPDATE t SET a = ${JSON.stringify(build(x, { y: (1) }))}::jsonb`);\n",
  );

  // GOOD: the fix — $1::text::jsonb.
  writeFileSync(
    join(goodDir, 'good_text.ts'),
    "await engine.executeRaw(`INSERT INTO t (a) VALUES ($1::text::jsonb)`, [JSON.stringify(x)]);\n",
  );
  // GOOD: template interpolation through ::text::jsonb, a documentation
  // comment, and the explicit opt-out.
  writeFileSync(
    join(goodDir, 'good_tpl.ts'),
    [
      "await exec.run(sqlFragment`UPDATE t SET a = ${JSON.stringify({ k: v })}::text::jsonb`);",
      "// bad example: ${JSON.stringify({ k: v })}::jsonb",
      "await exec.run(sqlFragment`UPDATE t SET a = ${JSON.stringify(x)}::jsonb`); // jsonb-guard-ok",
      "await exec.run(sqlFragment`UPDATE t SET a = ${jsonbParam({ k: v })}::jsonb`);",
      '',
    ].join('\n'),
  );
  // GOOD: text[] array path (the appendCompleted unnest shape).
  writeFileSync(
    join(goodDir, 'good_array.ts'),
    "await engine.executeRaw(`INSERT INTO t (a) SELECT unnest($1::text[])`, [JSON.stringify(arr)]);\n",
  );
  // GOOD: executeRawJsonb passes a raw object, not a string — excluded.
  writeFileSync(
    join(goodDir, 'good_helper.ts'),
    "await executeRawJsonb(engine, `INSERT INTO t (a) VALUES ($1::jsonb)`, [], [JSON.stringify(x)]);\n",
  );
  // GOOD: explicit opt-out for a rare legitimate object-binding case.
  writeFileSync(
    join(goodDir, 'good_optout.ts'),
    "await engine.executeRaw(`INSERT INTO t (a) VALUES ($1::jsonb)` /* jsonb-guard-ok */, [JSON.stringify(x)]);\n",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-jsonb-params guard', () => {
  test('flags positional $N::jsonb + JSON.stringify (incl. generic-typed calls)', () => {
    const { code, err } = runGuard(badDir);
    expect(code).toBe(1);
    expect(err).toContain('bad.ts');
    expect(err).toContain('bad_generic.ts');
    expect(err).toContain('bad_tpl_object.ts');
    expect(err).toContain('bad_tpl_nested.ts');
  });

  test('passes the sanctioned forms (::text::jsonb, ::text[], executeRawJsonb, jsonbParam, opt-out)', () => {
    const { code, err } = runGuard(goodDir);
    expect(code).toBe(0);
    expect(err).toContain('clean');
  });
});
