import type { Migration } from './types.ts';
import { migrationNotice } from './helpers.ts';
import { repairEmbedSkipFrontmatter } from '../embed-skip-repair.ts';

/**
 * Fork: the embed-skip marker was double-encoded on Postgres and turned page
 * frontmatter into an array (see embed-skip-repair.ts). A migration rather
 * than a doctor step, because every damaged brain upgrades through it and the
 * damage keeps parking from taking effect until it is repaired.
 */
const sample = (pages: Array<{ source_id: string; slug: string }>): string =>
  pages.slice(0, 20).map(p => `${p.source_id}/${p.slug}`).join(', ') + (pages.length > 20 ? ', …' : '');

export const v282: Migration = {
  version: 282,
  name: 'fork_repair_embed_skip_frontmatter',
  idempotent: true,
  sql: '',
  handler: async engine => {
    const { repaired, untouched, gitCanonical } = await repairEmbedSkipFrontmatter(engine);
    if (repaired > 0) migrationNotice(`  v282: repaired ${repaired} page frontmatter(s) double-encoded by the embed-skip marker\n`);
    if (untouched.length > 0) {
      migrationNotice(`  v282: left ${untouched.length} page(s) whose frontmatter is a JSON array of another shape: ${sample(untouched)}\n`);
    }
    if (gitCanonical.length > 0) {
      migrationNotice(`  v282: left ${gitCanonical.length} damaged page(s) in git-canonical sources, which only the git write path may change: ${sample(gitCanonical)}. `
        + `The page files in git are intact; the next change to each file re-imports its frontmatter.\n`);
    }
  },
};
