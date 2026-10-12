import type { Migration } from './types.ts';
import { v150 } from './v150-canonical-page-revisions-and-guards.ts';

export const v242: Migration = { ...v150, version: 242, name: 'fork_replay_upstream_v150_canonical_page_revisions' };
