import type { Migration } from './types.ts';

/**
 * Placeholder for the fork's former v241, which replayed upstream v166-v169.
 * runMigrations() now replays them for historical fork brains before any newer
 * upstream migration runs; replaying them here, after v264, restored the
 * per-row INSERT withdrawal trigger that v264 made set-based.
 */
export const v278: Migration = {
  version: 278,
  name: 'fork_replay_upstream_v166_v169',
  idempotent: true,
  sql: '',
};
