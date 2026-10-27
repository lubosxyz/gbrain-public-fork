// Guard self-test fixture (known-BAD): the stringify argument is an object
// literal with a computed key, the shape that double-encoded the embed-skip
// marker on Postgres.
declare const sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;
declare const KEY: string;
declare const opts: { marker: unknown };
export async function bad(): Promise<void> {
  await sql`UPDATE pages SET frontmatter = frontmatter || ${JSON.stringify({ [KEY]: opts.marker })}::jsonb WHERE id = 1`;
}
