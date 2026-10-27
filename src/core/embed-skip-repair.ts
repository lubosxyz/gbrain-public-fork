/**
 * Repair for page frontmatter that a double-encoded `markEmbedSkip` turned
 * into an array on Postgres.
 *
 * The marker patch was bound as a jsonb string, and `object || string` is an
 * array, so every park appended one more element: the original frontmatter
 * object, then one string per park holding the JSON text of
 * `{ "embed_skip": <marker> }`. Only that exact shape, with every marker shaped
 * exactly as `buildChunkTokenLimitMarker` writes it, is repaired, to the
 * object the writes meant to produce (`element 0 || <last marker>`). Any other
 * array is left alone and reported. PGLite never wrote the bad shape, so there
 * the repair finds nothing.
 */
import type { BrainEngine } from './engine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';

type JsonObject = Record<string, unknown>;
type PageRef = { source_id: string; slug: string };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Optimistic-write attempts per row before the repair gives up on it. */
export const EMBED_SKIP_REPAIR_ATTEMPTS = 3;

/** True only for the marker `buildChunkTokenLimitMarker` produces (the sole `markEmbedSkip` caller). */
function isChunkTokenLimitMarker(marker: unknown): marker is JsonObject {
  if (!isObject(marker)) return false;
  const keys = Object.keys(marker).sort();
  if (keys.length !== 3 || keys[0] !== 'assessed_at' || keys[1] !== 'bytes' || keys[2] !== 'reason') return false;
  if (marker.reason !== 'chunk_token_limit') return false;
  if (!Number.isSafeInteger(marker.bytes) || (marker.bytes as number) < 0) return false;
  if (typeof marker.assessed_at !== 'string') return false;
  const at = new Date(marker.assessed_at);
  return !Number.isNaN(at.getTime()) && at.toISOString() === marker.assessed_at;
}

/**
 * The last marker of a double-encoded embed-skip frontmatter, or undefined
 * when `frontmatter` has any other shape.
 */
export function doubleEncodedEmbedSkipMarker(frontmatter: unknown): JsonObject | undefined {
  if (!Array.isArray(frontmatter) || frontmatter.length < 2 || !isObject(frontmatter[0])) return undefined;
  let marker: JsonObject | undefined;
  for (const element of frontmatter.slice(1)) {
    if (typeof element !== 'string') return undefined;
    let patch: unknown;
    try { patch = JSON.parse(element); } catch { return undefined; }
    if (!isObject(patch) || Object.keys(patch).length !== 1 || !isChunkTokenLimitMarker(patch[EMBED_SKIP_KEY])) return undefined;
    marker = patch[EMBED_SKIP_KEY];
  }
  return marker;
}

export interface EmbedSkipRepairResult {
  repaired: number;
  /** Array frontmatter of any other shape, left as it is. */
  untouched: PageRef[];
  /**
   * Damaged pages in a git-canonical source, left as they are: the writer
   * guard admits only git-protocol writers there, and the repair does not
   * widen its grant to bypass that.
   */
  gitCanonical: PageRef[];
}

type Row = { id: number; source_id: string; slug: string; frontmatter: string; git_canonical: boolean };

export async function repairEmbedSkipFrontmatter(engine: BrainEngine): Promise<EmbedSkipRepairResult> {
  const rows = await engine.executeRaw<Row>(
    `SELECT p.id, p.source_id, p.slug, p.frontmatter::text AS frontmatter,
            COALESCE(s.config->>'canonical', '') = 'git' AS git_canonical
       FROM pages p LEFT JOIN sources s ON s.id = p.source_id
      WHERE jsonb_typeof(p.frontmatter) = 'array' ORDER BY p.id`);
  const result: EmbedSkipRepairResult = { repaired: 0, untouched: [], gitCanonical: [] };
  for (const row of rows) {
    const ref = { source_id: row.source_id, slug: row.slug };
    if (!doubleEncodedEmbedSkipMarker(JSON.parse(row.frontmatter))) result.untouched.push(ref);
    else if (row.git_canonical) result.gitCanonical.push(ref);
    else if (await repairRow(engine, row)) result.repaired++;
  }
  return result;
}

/**
 * Rewrite one damaged row. The text compare refuses a row changed since it was
 * read; the row is then re-read and re-evaluated. Returns false when the row
 * no longer needs the repair. Throws when it is still damaged after every
 * attempt, so the migration is not recorded and runs again on the next start.
 */
async function repairRow(engine: BrainEngine, row: Row): Promise<boolean> {
  let frontmatter: string = row.frontmatter;
  for (let attempt = 0; attempt < EMBED_SKIP_REPAIR_ATTEMPTS; attempt++) {
    const marker = doubleEncodedEmbedSkipMarker(JSON.parse(frontmatter));
    if (!marker) return false;
    // Element 0 is kept byte for byte by SQL. A managed brain's writer guard
    // refuses a frontmatter change outside a source capability, so the
    // statement grants this row's source only (transaction-local, as the
    // revision backfill does).
    const updated = await engine.executeRaw<{ id: number }>(
      `UPDATE pages SET frontmatter = (frontmatter -> 0) || $2::text::jsonb
        WHERE id = $1 AND frontmatter::text = $3
          AND set_config('gbrain.write_sources', $4, true) IS NOT NULL
        RETURNING id`,
      [row.id, JSON.stringify({ [EMBED_SKIP_KEY]: marker }), frontmatter, JSON.stringify([row.source_id])]);
    if (updated.length > 0) return true;
    const [current] = await engine.executeRaw<{ frontmatter: string }>(
      'SELECT frontmatter::text AS frontmatter FROM pages WHERE id = $1', [row.id]);
    if (!current) return false;
    frontmatter = current.frontmatter;
  }
  if (!doubleEncodedEmbedSkipMarker(JSON.parse(frontmatter))) return false;
  throw new Error(`embed-skip repair: ${row.source_id}/${row.slug} kept changing during the repair `
    + `(${EMBED_SKIP_REPAIR_ATTEMPTS} attempts); nothing was rewritten. Stop other gbrain writers and run the migrations again.`);
}
