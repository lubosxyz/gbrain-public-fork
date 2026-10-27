/**
 * Repair for page frontmatter that a double-encoded `markEmbedSkip` turned
 * into an array on Postgres.
 *
 * The marker patch was bound as a jsonb string, and `object || string` is an
 * array, so every park appended one more element: the original frontmatter
 * object, then one string per park holding the JSON text of
 * `{ "embed_skip": <marker> }`. Only that exact shape is repaired, to the
 * object the writes meant to produce (`element 0 || <last marker>`); any
 * other array is left alone and reported. PGLite never wrote the bad shape,
 * so there the repair finds nothing.
 */
import type { BrainEngine } from './engine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
    if (!isObject(patch) || Object.keys(patch).length !== 1 || !isObject(patch[EMBED_SKIP_KEY])) return undefined;
    marker = patch[EMBED_SKIP_KEY] as JsonObject;
  }
  return marker;
}

export interface EmbedSkipRepairResult {
  repaired: number;
  /** Array frontmatter of any other shape, left as it is. */
  untouched: Array<{ source_id: string; slug: string }>;
}

export async function repairEmbedSkipFrontmatter(engine: BrainEngine): Promise<EmbedSkipRepairResult> {
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; frontmatter: string }>(
    `SELECT id, source_id, slug, frontmatter::text AS frontmatter
       FROM pages WHERE jsonb_typeof(frontmatter) = 'array' ORDER BY id`);
  const result: EmbedSkipRepairResult = { repaired: 0, untouched: [] };
  for (const row of rows) {
    const marker = doubleEncodedEmbedSkipMarker(JSON.parse(row.frontmatter));
    if (!marker) {
      result.untouched.push({ source_id: row.source_id, slug: row.slug });
      continue;
    }
    // Element 0 is kept byte for byte by SQL. A managed brain's writer guard
    // refuses a frontmatter change outside a source capability, so the
    // statement grants this row's source only (transaction-local, as the
    // revision backfill does). The text compare skips a row changed since
    // the read.
    const updated = await engine.executeRaw<{ id: number }>(
      `UPDATE pages SET frontmatter = (frontmatter -> 0) || $2::text::jsonb
        WHERE id = $1 AND frontmatter::text = $3
          AND set_config('gbrain.write_sources', $4, true) IS NOT NULL
        RETURNING id`,
      [row.id, JSON.stringify({ [EMBED_SKIP_KEY]: marker }), row.frontmatter, JSON.stringify([row.source_id])]);
    if (updated.length > 0) result.repaired++;
  }
  return result;
}
