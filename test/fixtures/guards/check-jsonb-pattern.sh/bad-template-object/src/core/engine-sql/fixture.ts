// Known-bad: object-literal argument defeats the grep (`[^}]*` stops at the literal's `}`);
// the balanced-paren scanner in check-jsonb-params.mjs must flag it.
declare const sqlFragment: (strings: TemplateStringsArray, ...vals: unknown[]) => unknown;
export async function markParked(exec: any, slug: string, marker: unknown) {
  await exec.run(sqlFragment`UPDATE pages
    SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || ${JSON.stringify({ embed_skip: marker })}::jsonb
    WHERE slug = ${slug}`);
}
