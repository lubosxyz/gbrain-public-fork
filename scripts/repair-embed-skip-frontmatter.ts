#!/usr/bin/env bun
/**
 * Repair `pages.frontmatter` rows damaged by the v0.60.182.0 markEmbedSkip
 * double-encode (fixed in v0.60.183.0).
 *
 * The damaged write was `COALESCE(frontmatter, '{}') || ${JSON.stringify(patch)}::jsonb`.
 * On Postgres the string was bound as a jsonb STRING scalar, so `object || string`
 * produced an ARRAY: `[<original frontmatter object>, "<marker json text>"]`, and
 * every retry appended another string. PGLite never produced this shape.
 *
 * A row is repaired ONLY when all of these hold:
 *   - jsonb_typeof(frontmatter) = 'array'
 *   - element 0 is a JSON object
 *   - there is at least one further element, and every further element is a
 *     JSON string whose text parses to an object with exactly the key `embed_skip`
 * The repaired value is `element0 || <last marker object>` (the newest marker
 * wins, matching what a correct merge would have left). Any other array-shaped
 * frontmatter is reported and left untouched.
 *
 * Standalone and idempotent (a second run finds nothing to repair); this is a
 * maintenance script, not a schema migration. On a brain that guards canonical
 * page writes (managed persistence) the UPDATE is refused by the database guard,
 * the transaction rolls back and nothing changes.
 *
 * Usage:
 *   bun scripts/repair-embed-skip-frontmatter.ts                 # dry run (default)
 *   bun scripts/repair-embed-skip-frontmatter.ts --apply         # repair, one transaction
 *   bun scripts/repair-embed-skip-frontmatter.ts --json          # machine-readable report
 * The brain is the configured one; set DATABASE_URL in the environment to target a
 * Postgres brain explicitly (the URL is never taken from argv).
 * Exit: 0 success, 1 failure, 2 bad arguments.
 */
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EngineConfig } from '../src/core/types.ts';

const EMBED_SKIP = 'embed_skip';

export interface RepairRow {
  id: number;
  source_id: string;
  slug: string;
  /** Number of array elements, used to guard the UPDATE against a concurrent change. */
  elements: number;
}

export interface RepairReport {
  mode: 'dry-run' | 'apply';
  repairable: RepairRow[];
  /** Array-shaped frontmatter that does not match the damaged shape; never modified. */
  foreign: RepairRow[];
  repaired: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when `elements` is exactly the double-encode shape (see the header). */
export function isDamagedShape(elements: unknown): boolean {
  if (!Array.isArray(elements) || elements.length < 2) return false;
  if (!isPlainObject(elements[0])) return false;
  for (const el of elements.slice(1)) {
    if (typeof el !== 'string') return false;
    let parsed: unknown;
    try { parsed = JSON.parse(el); } catch { return false; }
    if (!isPlainObject(parsed)) return false;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== EMBED_SKIP) return false;
  }
  return true;
}

type Candidate = { id: number | string; source_id: string; slug: string; frontmatter: unknown };

async function classify(engine: BrainEngine, lock: boolean): Promise<{ repairable: RepairRow[]; foreign: RepairRow[] }> {
  // With --apply, `FOR UPDATE` keeps a concurrent writer from changing a row
  // between classification and the guarded UPDATE; a dry run takes no locks.
  const rows = await engine.executeRaw<Candidate>(
    `SELECT id, source_id, slug, frontmatter FROM pages
      WHERE jsonb_typeof(frontmatter) = 'array'
      ORDER BY source_id, slug${lock ? '\n        FOR UPDATE' : ''}`,
  );
  const repairable: RepairRow[] = [];
  const foreign: RepairRow[] = [];
  for (const r of rows) {
    // postgres.js returns jsonb parsed; a driver that hands back text is parsed here.
    const fm = typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter;
    const row: RepairRow = {
      id: Number(r.id),
      source_id: r.source_id,
      slug: r.slug,
      elements: Array.isArray(fm) ? fm.length : 0,
    };
    (isDamagedShape(fm) ? repairable : foreign).push(row);
  }
  return { repairable, foreign };
}

/**
 * Classify and, with `apply`, repair in one transaction. The UPDATE is pure SQL
 * (`element0 || (last element)::jsonb`), so nothing is re-encoded by a driver, and
 * it re-checks the shape guard (array, same length) so a row changed since
 * classification is skipped instead of overwritten.
 */
export async function repairEmbedSkipFrontmatter(
  engine: BrainEngine,
  opts: { apply: boolean },
): Promise<RepairReport> {
  return engine.transaction(async (tx) => {
    const { repairable, foreign } = await classify(tx, opts.apply);
    let repaired = 0;
    if (opts.apply) {
      for (const row of repairable) {
        const updated = await tx.executeRaw<{ id: number }>(
          `UPDATE pages
              SET frontmatter = (frontmatter -> 0)
                                || ((frontmatter ->> (jsonb_array_length(frontmatter) - 1))::jsonb)
            WHERE id = $1
              AND jsonb_typeof(frontmatter) = 'array'
              AND jsonb_array_length(frontmatter) = $2
          RETURNING id`,
          [row.id, row.elements],
        );
        repaired += updated.length;
      }
      if (repaired !== repairable.length) {
        // Aborts the transaction: a partial repair is never committed.
        throw new Error(
          `repaired ${repaired} of ${repairable.length} rows; a row changed during the run. Nothing was committed, re-run.`,
        );
      }
    }
    return { mode: opts.apply ? 'apply' : 'dry-run', repairable, foreign, repaired } as RepairReport;
  });
}

function bySource(rows: RepairRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.source_id) ?? [];
    list.push(r.slug);
    out.set(r.source_id, list);
  }
  return out;
}

export function renderReport(report: RepairReport): string {
  const lines: string[] = [`mode: ${report.mode}`];
  const section = (title: string, rows: RepairRow[]) => {
    lines.push('', `${title}: ${rows.length}`);
    for (const [source, slugs] of bySource(rows)) {
      lines.push(`  source ${source}: ${slugs.length}`);
      for (const slug of slugs) lines.push(`    ${slug}`);
    }
  };
  section(report.mode === 'apply' ? 'repaired' : 'would repair', report.repairable);
  section('other array-shaped frontmatter (left untouched)', report.foreign);
  if (report.mode === 'dry-run') lines.push('', 'Dry run: nothing was changed. Re-run with --apply to repair.');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun scripts/repair-embed-skip-frontmatter.ts [--apply] [--json]');
    return 0;
  }
  for (const a of args) {
    if (a !== '--apply' && a !== '--json') { console.error(`Unknown option: ${a}`); return 2; }
  }

  const config = loadConfig();
  let engineConfig: EngineConfig;
  if (process.env.DATABASE_URL) engineConfig = { engine: 'postgres', database_url: process.env.DATABASE_URL };
  else if (config) engineConfig = toEngineConfig(config);
  else { console.error('No GBrain config found. Set DATABASE_URL, or run on the brain host.'); return 1; }

  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    const report = await repairEmbedSkipFrontmatter(engine, { apply: args.includes('--apply') });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message);
    if (message.includes('writer_coordinator_required')) {
      console.error('This brain guards canonical page writes: a direct repair is refused and nothing was changed. Repair it through the persistence writer administration, not this script.');
    }
    return 1;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

if (import.meta.main) process.exit(await main());
