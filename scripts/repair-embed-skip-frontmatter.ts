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
 *     JSON string whose text parses to exactly what markEmbedSkip writes:
 *     `{"embed_skip": {reason, bytes, assessed_at}}` with reason one of the known
 *     values, bytes a non-negative integer and assessed_at a canonical ISO timestamp string
 *     (no other keys at either level); assessed_at must be the canonical
 *     `toISOString()` form the builders write
 * The repaired value is `element0 || <last marker object>` (the newest marker
 * wins, matching what a correct merge would have left). Any other array-shaped
 * frontmatter is reported and left untouched.
 *
 * Standalone and idempotent (a second run finds nothing to repair); this is a
 * maintenance script, not a schema migration.
 *
 * Rows of a source whose canonical writes the database guard reserves for the
 * persistence coordinator (managed git-canonical sources) are NOT repaired here
 * and no grant is widened: each such row is rolled back to its own savepoint,
 * reported as skipped with the supported repair path, and the run continues.
 * A row that changed during the run is re-read and re-evaluated; it is only
 * counted as repaired when the guarded UPDATE actually changed it.
 *
 * The target brain is resolved ONLY through the standard gbrain config
 * (`loadConfig`: GBRAIN_DATABASE_URL, then a DATABASE_URL that is not just a
 * cwd .env leak, then the config file under GBRAIN_HOME). Before anything is
 * read or written the script prints a non-secret identity of that target
 * (engine, host:port/database or PGLite path, page count). The URL is never
 * taken from argv.
 *
 * Usage:
 *   bun scripts/repair-embed-skip-frontmatter.ts                 # dry run (default)
 *   bun scripts/repair-embed-skip-frontmatter.ts --apply         # repair, one transaction
 *   bun scripts/repair-embed-skip-frontmatter.ts --json          # machine-readable report
 * Exit: 0 every matched row is repaired (or none), 1 failure or any matched row
 * still damaged, 2 bad arguments. A dry run that finds damaged rows exits 0.
 */
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { EngineConfig } from '../src/core/types.ts';

const EMBED_SKIP = 'embed_skip';
const MARKER_REASONS = new Set(['oversized', 'chunk_token_limit']);
const MARKER_KEYS = ['assessed_at', 'bytes', 'reason'];
const MAX_ROW_ATTEMPTS = 3;

export interface RepairRow {
  id: number;
  source_id: string;
  slug: string;
  /** Number of array elements, used to guard the UPDATE against a concurrent change. */
  elements: number;
}

export interface SkippedRow extends RepairRow {
  /** Why the row was left damaged. */
  reason: 'writer_guard';
}

export interface TargetIdentity {
  engine: string;
  /** `host:port/database` for Postgres, the data directory for PGLite. Never credentials. */
  location: string;
  pages: number;
}

export interface RepairReport {
  mode: 'dry-run' | 'apply';
  target?: TargetIdentity;
  /** Rows matching the exact damaged shape at classification time. */
  repairable: RepairRow[];
  /** Array-shaped frontmatter that does not match the damaged shape; never modified. */
  foreign: RepairRow[];
  /** Rows the guarded UPDATE actually changed, and how many. */
  repairedRows: RepairRow[];
  repaired: number;
  /** Matched rows the database guard reserves for the persistence coordinator; left damaged. */
  skipped: SkippedRow[];
  /** Matched rows that kept changing during the run and are still damaged; left as they were. */
  unresolved: RepairRow[];
}

/** Matched rows still damaged after the run. */
export function stillDamaged(report: RepairReport): number {
  return report.skipped.length + report.unresolved.length;
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
    if (!isMarkerPatch(parsed)) return false;
  }
  return true;
}

/** Only the form the builders write (`now.toISOString()`): parseable-but-different spellings are not markers. */
function isCanonicalIso(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString() === v;
}

/** Exactly `{embed_skip: {reason, bytes, assessed_at}}` as markEmbedSkip writes it. */
function isMarkerPatch(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const top = Object.keys(v);
  if (top.length !== 1 || top[0] !== EMBED_SKIP) return false;
  const marker = v[EMBED_SKIP];
  if (!isPlainObject(marker)) return false;
  if (Object.keys(marker).sort().join(',') !== MARKER_KEYS.join(',')) return false;
  return (
    typeof marker.reason === 'string' && MARKER_REASONS.has(marker.reason) &&
    typeof marker.bytes === 'number' && Number.isInteger(marker.bytes) && marker.bytes >= 0 &&
    isCanonicalIso(marker.assessed_at)
  );
}

type Candidate = { id: number | string; source_id: string; slug: string; frontmatter: unknown };

/** postgres.js returns jsonb parsed; a driver that hands back text is parsed here. */
function parseFm(v: unknown): unknown {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

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
    const fm = parseFm(r.frontmatter);
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

const REPAIR_SQL = `UPDATE pages
              SET frontmatter = (frontmatter -> 0)
                                || ((frontmatter ->> (jsonb_array_length(frontmatter) - 1))::jsonb)
            WHERE id = $1
              AND jsonb_typeof(frontmatter) = 'array'
              AND jsonb_array_length(frontmatter) = $2
          RETURNING id`;

export type RowOutcome = 'repaired' | 'skipped' | 'resolved' | 'foreign' | 'unresolved';

/**
 * Repair one matched row inside its own savepoint (nested transaction), so a
 * refused UPDATE (the database writer guard) undoes only that row. A 0-row UPDATE means the row
 * moved: it is re-read and re-evaluated, never counted as repaired.
 */
export async function repairRow(tx: BrainEngine, row: RepairRow): Promise<RowOutcome> {
  for (let attempt = 0; attempt < MAX_ROW_ATTEMPTS; attempt++) {
    // Re-read and re-evaluate the CURRENT value; the UPDATE only runs on a row that
    // still matches the exact damaged shape, and is length-guarded against a move
    // between this read and the write.
    const now = await tx.executeRaw<{ frontmatter: unknown }>(`SELECT frontmatter FROM pages WHERE id = $1`, [row.id]);
    if (now.length === 0) return 'resolved';
    const fm = parseFm(now[0].frontmatter);
    if (!Array.isArray(fm)) return 'resolved';
    if (!isDamagedShape(fm)) return 'foreign';

    try {
      // A nested transaction is a real savepoint on both engines: a refused UPDATE
      // undoes only this row, and postgres.js does not mark the outer one failed
      // (a hand-written SAVEPOINT statement would).
      const updated = await tx.transaction(inner => inner.executeRaw<{ id: number }>(REPAIR_SQL, [row.id, fm.length]));
      if (updated.length > 0) return 'repaired';
    } catch (e) {
      if (e instanceof Error && e.message.includes('writer_coordinator_required')) return 'skipped';
      throw e;
    }
  }
  return 'unresolved';
}

/**
 * Classify and, with `apply`, repair in one transaction. The UPDATE is pure SQL
 * (`element0 || (last element)::jsonb`), so nothing is re-encoded by a driver, and
 * it re-checks the shape guard (array, same length) so a row changed since
 * classification is re-evaluated instead of overwritten.
 */
export async function repairEmbedSkipFrontmatter(
  engine: BrainEngine,
  opts: { apply: boolean },
): Promise<RepairReport> {
  return engine.transaction(async (tx) => {
    const { repairable, foreign } = await classify(tx, opts.apply);
    const report: RepairReport = {
      mode: opts.apply ? 'apply' : 'dry-run',
      repairable,
      foreign: [...foreign],
      repairedRows: [],
      repaired: 0,
      skipped: [],
      unresolved: [],
    };
    if (opts.apply) {
      for (const row of repairable) {
        const outcome = await repairRow(tx, row);
        if (outcome === 'repaired') { report.repaired++; report.repairedRows.push(row); }
        else if (outcome === 'skipped') report.skipped.push({ ...row, reason: 'writer_guard' });
        else if (outcome === 'unresolved') report.unresolved.push(row);
        else if (outcome === 'foreign') report.foreign.push(row);
      }
    }
    return report;
  });
}

/** Resolve the target the way every other gbrain command does; the URL never comes from argv. */
export function resolveTargetConfig(): EngineConfig | null {
  const config = loadConfig();
  return config ? toEngineConfig(config) : null;
}

/** Non-secret identity of the target: no user, password or query string. */
export function describeTarget(cfg: EngineConfig): Omit<TargetIdentity, 'pages'> {
  if (cfg.engine === 'pglite') return { engine: 'pglite', location: cfg.database_path || '(in-memory)' };
  try {
    const u = new URL(cfg.database_url ?? '');
    return { engine: 'postgres', location: `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}` };
  } catch {
    return { engine: 'postgres', location: '(unparseable database url)' };
  }
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
  const lines: string[] = [];
  if (report.target) lines.push(`target: ${report.target.engine} ${report.target.location} (${report.target.pages} pages)`);
  lines.push(`mode: ${report.mode}`);
  const section = (title: string, rows: RepairRow[]) => {
    lines.push('', `${title}: ${rows.length}`);
    for (const [source, slugs] of bySource(rows)) {
      lines.push(`  source ${source}: ${slugs.length}`);
      for (const slug of slugs) lines.push(`    ${slug}`);
    }
  };
  section(report.mode === 'apply' ? 'repaired' : 'would repair', report.mode === 'apply' ? report.repairedRows : report.repairable);
  if (report.mode === 'apply') {
    section('skipped, reserved for the persistence coordinator (left damaged)', report.skipped);
    section('changed during the run, still damaged (left as they were)', report.unresolved);
    if (report.skipped.length > 0) {
      lines.push('', 'Skipped rows belong to a source whose canonical writes go through the persistence coordinator; repair them through its supported administration path, not this script.');
    }
  }
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

  const engineConfig = resolveTargetConfig();
  if (!engineConfig) { console.error('No GBrain config found. Configure the brain (GBRAIN_HOME / gbrain init) or set GBRAIN_DATABASE_URL.'); return 1; }

  const engine = await createEngine(engineConfig);
  try {
    await engine.connect(engineConfig);
    const count = await engine.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM pages');
    const target: TargetIdentity = { ...describeTarget(engineConfig), pages: Number(count[0]?.n ?? 0) };
    console.error(`target: ${target.engine} ${target.location} (${target.pages} pages)`);
    const report = await repairEmbedSkipFrontmatter(engine, { apply: args.includes('--apply') });
    report.target = target;
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
    return report.mode === 'apply' && stillDamaged(report) > 0 ? 1 : 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

if (import.meta.main) process.exit(await main());
