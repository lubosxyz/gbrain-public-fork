import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { persistenceHome } from './identity.ts';
import { canonicalFilesystemPath } from './root-registry.ts';

/** The reservation record refuses a coordination lock stored inside its canonical checkout. */
export function isOutsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

// Per-user fallback, used only when the brain's own persistence home sits inside the checkout.
function userCoordinationLocks(): string {
  const override = process.env.GBRAIN_COORDINATION_HOME?.trim();
  if (override) {
    if (!isAbsolute(override) || override.split(/[\\/]/).includes('..')) {
      throw new OperationError('invalid_params', 'GBRAIN_COORDINATION_HOME must be an absolute path without ".." segments.');
    }
    return join(override, 'locks');
  }
  return join(homedir(), '.gbrain', 'persistence', 'locks');
}

/**
 * Stable coordination lock path for one worktree, always outside its canonical checkout.
 *
 * The lock identifies the physical checkout across reclones, so a reclone must not be able to
 * copy it — hence the reservation validator rejects a lock under the root. The default location
 * is the brain's own persistence home, but `GBRAIN_HOME` may point at the brain repository
 * itself, and then that home IS inside the canonical root. In that topology the lock moves to the
 * per-user persistence home (or `GBRAIN_COORDINATION_HOME`), which keeps one stable path per
 * worktree id without ever living in the checkout.
 */
export function coordinationLockPath(root: string, worktreeId: string): string {
  const canonicalRoot = canonicalFilesystemPath(root);
  for (const base of [join(persistenceHome(), 'locks'), userCoordinationLocks()]) {
    const candidate = canonicalFilesystemPath(join(base, `${worktreeId}.lock`));
    if (isOutsideRoot(canonicalRoot, candidate)) return candidate;
  }
  throw new OperationError('storage_error', 'No coordination lock directory lives outside this canonical checkout.',
    'Point GBRAIN_COORDINATION_HOME at a directory outside the source root.');
}
