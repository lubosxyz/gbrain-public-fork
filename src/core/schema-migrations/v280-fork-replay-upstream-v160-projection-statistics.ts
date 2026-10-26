import type { Migration } from './types.ts';
import { v160 } from './v160-current-text-projection-planner-statistics.ts';

export const v280: Migration = {
  ...v160,
  version: 280,
  name: 'fork_replay_upstream_v160_projection_statistics',
  handler: v160.handler,
};
