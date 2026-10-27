import type { BrainEngine } from './engine.ts';
import type { Migration } from './schema-migrations/types.ts';

/**
 * Historical fork brains reused scalar schema versions that upstream assigns
 * to different DDL, so the pending loop would skip the upstream migrations
 * they never ran. Replay those prerequisites BEFORE newer migrations run:
 * replaying old upstream DDL after newer upstream migrations reverts them,
 * which is why the fork's former replay migrations (v278-v281) are empty.
 * Each pass stamps its config marker only after all its replays succeed.
 */
export async function repairForkSchemaPrerequisites(
  engine: BrainEngine,
  current: number,
  migrations: readonly Migration[],
  apply: (engine: BrainEngine, m: Migration) => Promise<void>,
): Promise<void> {
  const replay = (version: number) => apply(engine, migrations.find(m => m.version === version)!);
  const isForkBrain = async () => (await engine.executeRaw<{ present: boolean }>(
    "SELECT to_regclass('public.mcp_request_log_purged') IS NOT NULL AS present"))[0]?.present === true;

  // Forks used 150, 160-161 and 166-169 for different DDL (v174 already
  // requires v169's withdrawal subject).
  if (current >= 150 && current < 240 && await engine.getConfig('fork.schema_prerequisites.v060') !== 'complete' && await isForkBrain()) {
    for (const version of [150, 160, 161, 166, 167, 168, 169]) if (version <= current) await replay(version);
    await engine.setConfig('fork.schema_prerequisites.v060', 'complete');
  }

  // The fork's replays once held 240-244 (old 241: v166-v169, 242: v150,
  // 243: v160, 244: v161). A brain stamped 240-244 gets the old replays it
  // had not reached, then each upstream migration at or below its stamp.
  if (current >= 240 && current <= 244 && await engine.getConfig('fork.schema_prerequisites.v0604') !== 'complete' && await isForkBrain()) {
    const oldForkReplays: Array<[number, number[]]> = [[241, [166, 167, 168, 169]], [242, [150]], [243, [160]], [244, [161]]];
    for (const [oldVersion, replayed] of oldForkReplays) if (oldVersion > current) for (const version of replayed) await replay(version);
    for (const version of [240, 241, 242, 243, 244]) if (version <= current) await replay(version);
    await engine.setConfig('fork.schema_prerequisites.v0604', 'complete');
  }
}
