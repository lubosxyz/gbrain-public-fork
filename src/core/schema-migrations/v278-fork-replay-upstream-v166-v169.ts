import type { Migration } from './types.ts';
import { v166 } from './v166-fact-embedding-identity.ts';
import { v167 } from './v167-facts-superseded-by-set-null.ts';
import { v168 } from './v168-dream-synthesis-completions.ts';
import { v169 } from './v169-fact-withdrawal-subject.ts';

/** Fork installations used 166–169 before these upstream migrations existed. */
export const v278: Migration = {
  version: 278,
  name: 'fork_replay_upstream_v166_v169',
  idempotent: true,
  sql: [v166.sql, v167.sql, v168.sql, v169.sql].join('\n'),
};
