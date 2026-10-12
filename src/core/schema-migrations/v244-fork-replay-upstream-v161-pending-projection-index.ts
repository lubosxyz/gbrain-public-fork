import type { Migration } from './types.ts';
import { v161 } from './v161-index-pending-text-projections.ts';

export const v244: Migration = { ...v161, version: 244, name: 'fork_replay_upstream_v161_pending_projection_index' };
