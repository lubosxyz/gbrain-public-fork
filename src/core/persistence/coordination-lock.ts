import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';
import { localHostId, persistenceHome } from './identity.ts';
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
/**
 * Namespace for the shared fallback. The canonical root alone is not unique: two machines can
 * share a home over NFS and hold different checkouts at the same local path, and a restored
 * database clone keeps the worktree id. The registered host identity separates those.
 */
export function coordinationNamespace(canonicalRoot: string): string {
  return sha256(`${canonicalRoot}\0${localHostId()}`).slice(0, 32);
}

export function coordinationLockPath(root: string, worktreeId: string): string {
  const canonicalRoot = canonicalFilesystemPath(root);
  // The shared fallback is namespaced by the canonical root, not just by worktree id: two brains
  // restored from one database clone keep the same worktree id on different checkouts, and a flat
  // directory would make their unrelated writes block on one lock file. The root is the identity
  // the lock protects, and it survives a reclone into the same path.
  const shared = join(userCoordinationLocks(), coordinationNamespace(canonicalRoot));
  for (const base of [join(persistenceHome(), 'locks'), shared]) {
    const candidate = canonicalFilesystemPath(join(base, `${worktreeId}.lock`));
    if (isOutsideRoot(canonicalRoot, candidate)) return candidate;
  }
  throw new OperationError('storage_error', 'No coordination lock directory lives outside this canonical checkout.',
    'Point GBRAIN_COORDINATION_HOME at a directory outside the source root.');
}

/**
 * Which lock a successor coordinates on after a verified transfer.
 *
 * The successor's own reservation is the physical identity of that checkout, so it wins: preferring
 * a historical binding over it makes the physical-root check reject the mismatch and leaves the
 * worktree draining. A recorded binding path is the fallback that keeps one stable lock when the
 * successor has no reservation yet, and it is ignored when it points inside the successor root.
 * Only a worktree with neither mints a fresh path.
 */
export function successorCoordinationPath(root: string, reserved: string | null, recorded: string | null,
  worktreeId: string): string {
  if (reserved) return reserved;
  if (recorded && isOutsideRoot(canonicalFilesystemPath(root), canonicalFilesystemPath(recorded))) return recorded;
  return coordinationLockPath(root, worktreeId);
}
