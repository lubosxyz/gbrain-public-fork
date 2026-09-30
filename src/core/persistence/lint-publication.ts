import { dirname, isAbsolute, relative, sep } from 'node:path';
import { statSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { readSourceFileSync } from '../minions/source-filesystem.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { maintenancePreflight, publishMaintenancePage } from './prepared-maintenance.ts';

/** Lint repairs are ordinary revision-checked maintenance publications. */
export async function managedLintPublisher(engine: BrainEngine, target: string) {
  const canonical = canonicalFilesystemPath(target);
  const directory = statSync(canonical).isFile() ? dirname(canonical) : canonical;
  const rows = await engine.executeRaw<{ id: string; local_path: string | null }>(
    'SELECT id,local_path FROM sources WHERE archived=false');
  const fallback = await engine.getConfig('sync.repo_path');
  const sources = rows.flatMap(row => {
    const path = row.local_path || (row.id === 'default' ? fallback : null);
    return path ? [{ id: row.id, root: canonicalFilesystemPath(path) }] : [];
  });
  const enclosingSources = sources.filter(source => {
    const rel = relative(source.root, directory);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  }).sort((a, b) => b.root.length - a.root.length);
  const source = enclosingSources[0];
  if (!source) throw new OperationError('source_changed', 'Lint requires a registered canonical source directory.');
  const authority = await maintenancePreflight(engine, source.id, source.root);
  if (!authority?.binding) throw new OperationError('source_changed', 'Persistence changed during lint preparation.');
  return async (path: string) => {
    const canonicalPath = canonicalFilesystemPath(path);
    const rel = relative(source.root, canonicalPath);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || sources.some(other =>
      other.id !== source.id && other.root.length >= source.root.length &&
      (canonicalPath === other.root || canonicalPath.startsWith(other.root + sep)))) {
      throw new OperationError('source_changed', 'Lint cannot cross a source boundary.');
    }
    const sourcePath = rel.split(sep).join('/');
    const [page] = await engine.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL', [source.id, sourcePath]);
    if (!page) throw new OperationError('page_not_found', 'Sync this file before applying a managed lint repair.');
    const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: source.id });
    if (!snapshot) throw new OperationError('page_not_found', 'The lint target disappeared.');
    await prepareFileTarget(engine, { source_id: source.id, worktree_id: authority.binding?.worktree_id ?? null, slug: page.slug }, snapshot, null);
    const content = readSourceFileSync(path, 'utf-8');
    return { content, publish: async (fixed: string) => {
      const receipt = await publishMaintenancePage(engine, authority, page.slug, fixed, { expectedRevision: snapshot.revision });
      if (receipt.state !== 'committed') throw new OperationError('write_pending', 'The lint repair has not committed; inspect writer status.');
    } };
  };
}
