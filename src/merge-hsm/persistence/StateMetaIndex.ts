import type { PersistedHSMRecord, PersistedStateMeta } from '../types';

/** Project state without retaining note contents or fork bodies. */
export function stateMeta(record: PersistedHSMRecord): PersistedStateMeta {
  if (record.kind === 'canvas') {
    return {
      kind: 'canvas',
      guid: record.guid,
      path: record.path,
      folder: record.folder,
      lcaMeta: record.lca
        ? { meta: { hash: record.lca.hash, mtime: record.lca.mtime } }
        : null,
      disk: record.disk,
      localSnapshot: record.localSnapshot ?? null,
      lastStatePath: record.lastStatePath as PersistedStateMeta['lastStatePath'],
      hasFork: false,
      persistedAt: record.persistedAt,
    };
  }
  return {
    guid: record.guid,
    path: record.path,
    folder: record.folder,
    // A persisted baseline is usable only when it includes its snapshot.
    lcaMeta: record.lca?.snapshot
      ? {
          meta: { hash: record.lca.hash, mtime: record.lca.mtime },
          snapshot: record.lca.snapshot,
        }
      : null,
    disk: record.disk,
    localSnapshot: record.localSnapshot ?? null,
    lastStatePath: record.lastStatePath,
    deferredConflict: record.deferredConflict,
    hasFork: !!record.fork,
    persistedAt: record.persistedAt,
  };
}

/** Vault-scoped, in-memory projection of committed state records. */
export class StateMetaIndex {
  private records = new Map<string, PersistedStateMeta>();
  private folders = new Map<string | undefined, Map<string, PersistedStateMeta>>();

  set(meta: PersistedStateMeta): void {
    this.delete(meta.guid);
    this.records.set(meta.guid, meta);
    let folder = this.folders.get(meta.folder);
    if (!folder) {
      folder = new Map();
      this.folders.set(meta.folder, folder);
    }
    folder.set(meta.guid, meta);
  }

  delete(guid: string): void {
    const previous = this.records.get(guid);
    if (!previous) return;
    this.records.delete(guid);
    const folder = this.folders.get(previous.folder)!;
    folder.delete(guid);
    if (folder.size === 0) this.folders.delete(previous.folder);
  }

  clear(): void {
    this.records.clear();
    this.folders.clear();
  }

  all(): PersistedStateMeta[] {
    return structuredClone(Array.from(this.records.values()));
  }

  forFolder(folder: string, memberGuids: Iterable<string>): PersistedStateMeta[] {
    const result = new Map(this.folders.get(folder));
    const unscoped = this.folders.get(undefined);
    if (unscoped) {
      for (const guid of memberGuids) {
        const meta = unscoped.get(guid);
        if (meta) result.set(guid, meta);
      }
    }
    // Callers own their snapshots and may mutate them while restoring state.
    return structuredClone(Array.from(result.values()));
  }
}
