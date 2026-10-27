import type { Migration } from './types.ts';

/** Placeholder for the fork's former v243 (upstream v160 replay); see v278. */
export const v280: Migration = { version: 280, name: 'fork_replay_upstream_v160_projection_statistics', idempotent: true, sql: '' };
