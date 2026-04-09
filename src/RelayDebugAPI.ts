/**
 * RelayDebugAPI — Plugin-level debug surface exposed as `window.__relayDebug`.
 *
 * Aggregates per-folder recording bridges and provides CDP-accessible
 * utilities for E2E tests, live debugging, and diagnostics.
 *
 * Lifecycle: created in plugin onload(), destroyed in onunload().
 */

import * as Y from 'yjs';
import { diff_match_patch } from 'diff-match-patch';
import { IndexeddbPersistence } from './storage/y-indexeddb';
import type { E2ERecordingBridge, E2ERecordingState } from './merge-hsm/recording';
import { getHSMBootId, getHSMBootEntries, getRecentEntries, getSessionLogs } from './debug';
import type { SessionLogOptions } from './debug';

// =============================================================================
// Types
// =============================================================================

export interface DocumentContentSnapshot {
  path: string;
  guid: string;
  folder: string;
  local: { content: string; stateVector: string } | null;
  remote: { content: string; stateVector: string } | null;
  idb: { content: string; stateVector: string } | null;
  disk: { content: string; mtime: number } | null;
  server: { content: string; stateVector: string; updateSize: number } | null;
}

export interface HsmStateTransition {
  ts: number;
  seq: number;
  event: string;
  from: string;
  to: string;
}

export interface HsmSyncGate {
  providerConnected: boolean;
  providerSynced: boolean;
  localOnly: boolean;
  pendingInbound: number;
  pendingOutbound: number;
}

export interface IdbContentSnapshot {
  path: string;
  guid: string;
  folder: string;
  dbName: string;
  metadata: Record<string, any>;
  updatesCount: number;
  idbContent: string | null;
  idbLength: number;
  diskContent: string | null;
  diskLength: number | null;
  match: boolean;
}

export interface IdbHistoryEntry {
  key: IDBValidKey;
  origin: any;
  timestamp: number | null;
  time: string | null;
  insertionsBytes: number;
  deletionsBytes: number;
}

export interface IdbHistorySnapshot {
  path: string;
  guid: string;
  folder: string;
  dbName: string;
  historyCount: number;
  inMemoryCount: number | null;
  entries: IdbHistoryEntry[];
  note?: string;
}

export interface ForkSnapshot {
  base: string | null;
  baseLength: number;
  origin: string | null;
  created: number | null;
  createdTime: string | null;
  captureMark: any;
  localStateVectorBytes: number;
  remoteStateVectorBytes: number;
}

export interface IdbForkSnapshot {
  path: string;
  guid: string;
  folder: string;
  statePath: string;
  hasFork: boolean;
  inMemoryFork: ForkSnapshot | null;
  persistedFork: ForkSnapshot | { error: string } | null;
  persistedMeta: {
    lastStatePath: string | null;
    persistedAt: number | null;
    persistedAtTime: string | null;
    hasForkInPersistedState: boolean;
  } | null;
}

/**
 * Rich snapshot of an HSM's state, covering every layer the test harness
 * routinely inspects: state path + sync gate (from the machine), LCA meta
 * and content (from the HSM), localDoc length/content/frontmatter (from
 * the in-memory Y.Doc), disk content + mtime (via the vault adapter), and
 * recent HSM transitions (via the disk log). Replaces the ad-hoc 120-line
 * eval blob that used to live in the Python CLI.
 */
/**
 * A single conflict hunk with both a transient `index` (into the
 * current `conflictRegions` array) and a content-derived stable `id`.
 * Use `id` when you need to survive waits, re-entries, or persisted
 * conflict restoration; use `index` for tight loops within one session.
 */
export interface ConflictHunkInfo {
  /** Current array index — unstable if conflictData is re-created. */
  index: number;
  /**
   * Content-hash prefix (grown to the minimum length that uniquely
   * identifies the hunk among the current set — jj/git style). Derived
   * from `oursContent + '\0' + theirsContent`, so it's stable across
   * re-parses as long as the hunk's content is unchanged. Position is
   * deliberately excluded so that earlier hunks resolving (which
   * shifts later positions) doesn't invalidate the id. `resolveHunk`
   * accepts any unambiguous prefix of the full hash.
   */
  id: string;
  /** Line number in the base (LCA) text where the hunk starts. */
  baseStart: number;
  /** Line number in the base (LCA) text where the hunk ends. */
  baseEnd: number;
  /** Whether the HSM has marked this hunk resolved via RESOLVE_HUNK. */
  resolved: boolean;
  /** Local/editor side of the hunk (what resolution="local" picks). */
  oursContent: string;
  /** Remote/peer side of the hunk (what resolution="remote" picks). */
  theirsContent: string;
}

/**
 * Focused snapshot of an HSM's conflict state. Exposed so test scripts
 * can discover what `ours`/`theirs` hold without pulling the full
 * HsmStateSnapshot. The labels disambiguate which side is which: the
 * HSM internally uses `ours` for yjs/remote text and `theirs` for
 * editor/local text, but the labels carry the semantic meaning.
 */
export interface ConflictInfoSnapshot {
  path: string;
  guid: string;
  statePath: string;
  hasConflict: boolean;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  oursLabel: string | null;
  theirsLabel: string | null;
  /** Per-hunk detail with stable content-hash ids. */
  hunks: ConflictHunkInfo[];
  /** Total number of conflict hunks (regions) discovered. */
  hunkCount: number;
  /** Number of hunks already resolved via RESOLVE_HUNK. */
  resolvedHunkCount: number;
}

export interface HsmStateSnapshot {
  path: string;
  guid: string;
  folder: string;
  statePath: string;
  syncGate: HsmSyncGate | null;
  hasLCA: boolean;
  lcaHash: string | null;
  lcaContentLength: number | null;
  lcaContent: string | null;
  hasConflict: boolean;
  conflictData: any | null;
  localDocLength: number;
  idbContent: string | null;
  diskMtime: number | null;
  diskContent: string | null;
  stateVectorsEqual: boolean | null;
  diskMatchesIdb: boolean;
  idbMatchesLca: boolean;
  frontmatterMap: Record<string, any> | null;
  recentTransitions: HsmStateTransition[];
}

// =============================================================================
// Global interface exposed via CDP
// =============================================================================

export interface RelayDebugGlobal {
  /** Start recording all HSM activity */
  startRecording: (name?: string) => E2ERecordingState;
  /** Stop recording and return lightweight summary JSON */
  stopRecording: () => string;
  /** Get current recording state */
  getState: () => E2ERecordingState;
  /** Check if recording is active */
  isRecording: () => boolean;
  /** Get list of active document GUIDs */
  getActiveDocuments: () => string[];
  /** Get the current boot ID (for disk recording) */
  getBootId: () => string | null;
  /** Get entries from current boot (reads disk file, filters by boot ID) */
  getBootEntries: () => Promise<object[]>;
  /** Get last N entries for a specific document (buffer + disk, newest files first) */
  getRecentEntries: (guid: string, limit?: number) => Promise<object[]>;
  /** Read Y.Doc text content from IndexedDB without waking the HSM */
  readIdbContent: (guid: string, appId: string) => Promise<{ content: string; stateVector: Uint8Array } | null>;
  /** Get plugin log entries from the current session, with optional level/pattern filtering */
  getSessionLogs: (options?: SessionLogOptions) => Promise<object[]>;
  /** Get a snapshot of all content views for a document */
  getDocumentContent: (path: string) => Promise<DocumentContentSnapshot>;
  /** Set the active editor's content via minimal CM6 transactions (simulates user typing) */
  setEditorContent: (content: string) => { success: boolean; changeCount: number } | { error: string };
  /** Look up a document by vault-scoped path (e.g. "private/foo.md"). Returns document, HSM, folder, and GUID. */
  lookupDocument: (path: string) => { doc: any; hsm: any; guid: string; folder: any; filePath: string } | null;
  /** Look up a shared folder by path (e.g. "private"). Returns the SharedFolder or null. */
  lookupFolder: (path: string) => any | null;
  /** Get a rich HSM state snapshot for the test harness — state path, LCA, disk, IDB, SV, frontmatter, recent transitions. */
  getHsmStateSnapshot: (path: string) => Promise<HsmStateSnapshot>;
  /** Snapshot the per-doc IndexedDB: updates count, custom metadata, IDB content, disk content, match flag. */
  getIdbContent: (path: string) => Promise<IdbContentSnapshot>;
  /** Snapshot the OpCapture history store for a document. */
  getIdbHistory: (path: string) => Promise<IdbHistorySnapshot>;
  /** Snapshot in-memory and persisted fork state for a document. */
  getIdbFork: (path: string) => Promise<IdbForkSnapshot>;
  /**
   * Wait for an HSM to reach a state path that starts with `statePrefix`,
   * subject to a timeout. Resolves with the final state path on success.
   * Thin bridge over `MergeHSM.awaitState` — event-driven, no polling.
   */
  awaitHsmState: (path: string, statePrefix: string, timeoutMs: number) => Promise<string>;
  /**
   * Focused conflict snapshot: base/ours/theirs plus labels so callers
   * can pick the right side by semantic name without pulling the whole
   * HsmStateSnapshot. Throws if the document is not found.
   */
  getConflictInfo: (path: string) => Promise<ConflictInfoSnapshot>;
  /**
   * Dispatch a `RESOLVE` event to the HSM with the chosen final content.
   * Goes through `hsm.send()` so the state machine drives the transition
   * (editor must be active — the action reads `lastKnownEditorText`).
   * Returns the state path after the event dispatch completes.
   */
  resolveConflict: (path: string, contents: string) => Promise<string>;
  /**
   * Dispatch a `RESOLVE_HUNK` event for a single conflict hunk.
   *
   * `indexOrId` picks the hunk:
   *   - number → treated as the current array index (fast, session-local)
   *   - string → matched against `ConflictHunkInfo.id`; throws on
   *     ambiguous (collision) or missing
   *
   * `resolution` picks the content:
   *   - "local"  → the hunk's oursContent
   *   - "remote" → the hunk's theirsContent
   *   - "both"   → oursContent + "\n" + theirsContent
   *
   * The HSM mutates localDoc in place at the hunk's positioned region,
   * marks the index resolved, and once every hunk is resolved it
   * auto-sends `RESOLVE` with the final content. Returns the state
   * path after dispatch.
   */
  resolveHunk: (
    path: string,
    indexOrId: number | string,
    resolution: 'local' | 'remote' | 'both',
  ) => Promise<string>;
  /**
   * Dispatch an `OPEN_DIFF_VIEW` event — the state-machine-level
   * equivalent of the user clicking the conflict banner. Transitions
   * `active.conflict.bannerShown` → `active.conflict.resolving`. This
   * only drives the HSM; it does not open a diff view leaf in the UI.
   * Returns the state path after dispatch.
   */
  openDiffView: (path: string) => Promise<string>;
  /**
   * Dispatch a `CANCEL` event — the state-machine-level equivalent of
   * the user closing the diff view without resolving. Transitions
   * `active.conflict.resolving` → `active.conflict.bannerShown`.
   * Returns the state path after dispatch.
   */
  cancelDiffView: (path: string) => Promise<string>;
  /**
   * Clear the HSM's LCA in place. Low-level internal-state mutation —
   * reproduces the no-LCA state that arises after upgrading from a
   * plugin version without LCA tracking. On reopen the HSM enters
   * `isRecoveryMode` and routes to two-way merge.
   */
  clearLca: (path: string) => Promise<void>;
}

// =============================================================================
// RelayDebugAPI
// =============================================================================

export class RelayDebugAPI {
  private bridges = new Map<string, E2ERecordingBridge>();
  private activeRecordingName: string | null = null;
  private plugin: any;

  constructor(plugin?: any) {
    this.plugin = plugin;
    this.installGlobal();
  }

  /**
   * Register a per-folder recording bridge.
   * Returns a cleanup function to call when the folder is destroyed.
   */
  registerBridge(folderPath: string, bridge: E2ERecordingBridge): () => void {
    this.bridges.set(folderPath, bridge);

    // Auto-start recording if one is currently active
    if (this.activeRecordingName !== null) {
      try {
        bridge.startRecording(this.activeRecordingName);
      } catch { /* already recording */ }
    }

    this.installGlobal();

    return () => {
      bridge.dispose();
      this.bridges.delete(folderPath);
      this.installGlobal();
    };
  }

  /**
   * Install the `window.__relayDebug` global.
   */
  private installGlobal(): void {
    const g = typeof window !== 'undefined' ? window : globalThis;

    const api: RelayDebugGlobal = {
      startRecording: (name) => {
        this.activeRecordingName = name ?? 'E2E Recording';
        const results: E2ERecordingState[] = [];
        for (const bridge of this.bridges.values()) {
          try { results.push(bridge.startRecording(name)); }
          catch { /* already recording */ }
        }
        return {
          recording: results.some(r => r.recording),
          name: name ?? null,
          id: results[0]?.id ?? null,
          startedAt: results[0]?.startedAt ?? null,
          documentCount: results.reduce((sum, r) => sum + r.documentCount, 0),
          totalEntries: results.reduce((sum, r) => sum + r.totalEntries, 0),
        };
      },

      stopRecording: () => {
        this.activeRecordingName = null;
        const recordings: string[] = [];
        for (const bridge of this.bridges.values()) {
          try { recordings.push(bridge.stopRecording()); }
          catch { /* not recording */ }
        }
        const combined = recordings.flatMap(r => {
          try { return JSON.parse(r); } catch { return []; }
        });
        return JSON.stringify(combined, null, 2);
      },

      getState: () => {
        let totalDocs = 0;
        let totalEntries = 0;
        let recording = false;
        let name: string | null = null;
        let id: string | null = null;
        let startedAt: string | null = null;

        for (const bridge of this.bridges.values()) {
          const state = bridge.getState();
          if (state.recording) {
            recording = true;
            name = name ?? state.name;
            id = id ?? state.id;
            startedAt = startedAt ?? state.startedAt;
          }
          totalDocs += state.documentCount;
          totalEntries += state.totalEntries;
        }

        return { recording, name, id, startedAt, documentCount: totalDocs, totalEntries };
      },

      isRecording: () => {
        for (const bridge of this.bridges.values()) {
          if (bridge.isRecording()) return true;
        }
        return false;
      },

      getActiveDocuments: () => {
        const docs: string[] = [];
        for (const bridge of this.bridges.values()) {
          docs.push(...bridge.getActiveDocuments());
        }
        return docs;
      },

      getBootId: () => getHSMBootId(),
      getBootEntries: () => getHSMBootEntries(),
      getRecentEntries: (guid, limit) => getRecentEntries(guid, limit),
      readIdbContent: readIdbContent,
      getSessionLogs: (options) => getSessionLogs(options),
      getDocumentContent: async (path) => this.getDocumentContent(path),
      getHsmStateSnapshot: async (path) => this.getHsmStateSnapshot(path),
      getIdbContent: async (path) => this.getIdbContent(path),
      getIdbHistory: async (path) => this.getIdbHistory(path),
      getIdbFork: async (path) => this.getIdbFork(path),
      awaitHsmState: async (path, statePrefix, timeoutMs) =>
        this.awaitHsmState(path, statePrefix, timeoutMs),
      getConflictInfo: async (path) => this.getConflictInfo(path),
      resolveConflict: async (path, contents) => this.resolveConflict(path, contents),
      resolveHunk: async (path, indexOrId, resolution) =>
        this.resolveHunk(path, indexOrId, resolution),
      openDiffView: async (path) => this.sendConflictEvent(path, { type: 'OPEN_DIFF_VIEW' }),
      cancelDiffView: async (path) => this.sendConflictEvent(path, { type: 'CANCEL' }),
      clearLca: async (path) => this.clearLca(path),

      setEditorContent: (content: string) => {
        const editor = (this.plugin?.app as any)?.workspace?.activeEditor?.editor;
        if (!editor) return { error: 'No active editor' };
        const cm = editor.cm;
        if (!cm) return { error: 'No CM6 EditorView' };

        const before = cm.state.doc.toString();
        if (before === content) return { success: true, changeCount: 0 };

        const dmp = new diff_match_patch();
        const diffs = dmp.diff_main(before, content);
        dmp.diff_cleanupSemantic(diffs);

        const changes: { from: number; to: number; insert: string }[] = [];
        let pos = 0;
        for (const [op, text] of diffs) {
          if (op === 0) {
            pos += text.length;
          } else if (op === -1) {
            changes.push({ from: pos, to: pos + text.length, insert: '' });
            pos += text.length;
          } else if (op === 1) {
            changes.push({ from: pos, to: pos, insert: text });
          }
        }

        // Merge adjacent delete+insert into replacements
        const merged: typeof changes = [];
        let i = 0;
        while (i < changes.length) {
          const cur = changes[i];
          if (i + 1 < changes.length && cur.insert === '' &&
              changes[i + 1].from === cur.to && changes[i + 1].to === changes[i + 1].from) {
            merged.push({ from: cur.from, to: cur.to, insert: changes[i + 1].insert });
            i += 2;
          } else {
            merged.push(cur);
            i++;
          }
        }

        // Dispatch without ySyncAnnotation so HSM treats this as a user edit
        cm.dispatch({ changes: merged });
        return { success: true, changeCount: merged.length };
      },

      lookupFolder: (path: string) => {
        if (!this.plugin?.sharedFolders?._set) return null;
        for (const folder of this.plugin.sharedFolders._set.values()) {
          if ((folder as any).path === path) return folder;
        }
        // Also try matching as a prefix (e.g. "private" matches folder at path "private")
        for (const folder of this.plugin.sharedFolders._set.values()) {
          if (path.startsWith((folder as any).path + '/')) return folder;
        }
        return null;
      },

      lookupDocument: (path: string) => {
        if (!this.plugin?.sharedFolders?._set) return null;
        const folders = Array.from(this.plugin.sharedFolders._set.values()) as any[];

        // Resolve folder scope from vault path (e.g. "private/foo.md")
        let targetFolder: any = null;
        let relativePath = path;
        for (const folder of folders) {
          if (path.startsWith(folder.path + '/')) {
            targetFolder = folder;
            relativePath = path.slice(folder.path.length);
            break;
          }
        }

        const search = targetFolder ? [targetFolder] : folders;
        for (const folder of search) {
          const mm = folder.mergeManager;
          if (!mm?._syncStatus) continue;
          for (const [guid, _status] of mm._syncStatus.entries()) {
            const doc = mm._getDocument(guid);
            const hsm = doc?._hsm;
            if (!hsm) continue;
            let filePath = hsm.path || guid;

            if (guid === path) return { doc, hsm, guid, folder, filePath };
            const normFile = filePath.replace(/^\/+/, '');
            const normRel = relativePath.replace(/^\/+/, '');
            if (targetFolder && (filePath === relativePath || normFile === normRel))
              return { doc, hsm, guid, folder, filePath };
            if (!targetFolder && (filePath === path || normFile === path.replace(/^\/+/, '')))
              return { doc, hsm, guid, folder, filePath };
          }
        }
        return null;
      },

    };

    (g as any).__relayDebug = {
      ...api,
      registerBridge: (folderPath: string, bridge: E2ERecordingBridge) => this.registerBridge(folderPath, bridge),
    };
  }

  /**
   * Encode a Uint8Array as a hex string for JSON serialization.
   */
  private toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get a snapshot of all content views (local, remote, IDB, disk, server) for a document.
   */
  private async getDocumentContent(path: string): Promise<DocumentContentSnapshot> {
    if (!this.plugin?.sharedFolders?._set) {
      throw new Error('No shared folders available');
    }

    // Find the document across all shared folders
    let foundDoc: any = null;
    let foundFolder: any = null;

    for (const folder of this.plugin.sharedFolders._set.values()) {
      if (folder.files) {
        for (const doc of folder.files.values()) {
          if (doc.path === path) {
            foundDoc = doc;
            foundFolder = folder;
            break;
          }
        }
      }
      if (foundDoc) break;
    }

    if (!foundDoc || !foundFolder) {
      throw new Error(`Document not found: ${path}`);
    }

    const result: DocumentContentSnapshot = {
      path: foundDoc.path,
      guid: foundDoc.guid,
      folder: foundFolder.path || foundFolder.name,
      local: null,
      remote: null,
      idb: null,
      disk: null,
      server: null,
    };

    // Local doc
    try {
      const localDoc = foundDoc.localDoc;
      if (localDoc) {
        result.local = {
          content: localDoc.getText('contents').toString(),
          stateVector: this.toHex(Y.encodeStateVector(localDoc)),
        };
      }
    } catch { /* localDoc not available */ }

    // Remote doc (ydoc)
    try {
      const remoteDoc = foundDoc.ydoc;
      if (remoteDoc) {
        result.remote = {
          content: remoteDoc.getText('contents').toString(),
          stateVector: this.toHex(Y.encodeStateVector(remoteDoc)),
        };
      }
    } catch { /* remoteDoc not available */ }

    // IDB
    try {
      const idbResult = await readIdbContent(foundDoc.guid, foundFolder.appId);
      if (idbResult) {
        result.idb = {
          content: idbResult.content,
          stateVector: this.toHex(idbResult.stateVector),
        };
      }
    } catch { /* IDB not available */ }

    // Disk
    try {
      const adapter = this.plugin.app.vault.adapter;
      const content = await adapter.read(foundDoc.path);
      const stat = await adapter.stat(foundDoc.path);
      result.disk = {
        content,
        mtime: stat?.mtime ?? 0,
      };
    } catch { /* disk read failed */ }

    // Server
    try {
      const response = await foundFolder.backgroundSync.downloadItem(foundDoc);
      const rawUpdate = new Uint8Array(response.arrayBuffer);
      const tempDoc = new Y.Doc();
      Y.applyUpdate(tempDoc, rawUpdate);
      result.server = {
        content: tempDoc.getText('contents').toString(),
        stateVector: this.toHex(Y.encodeStateVector(tempDoc)),
        updateSize: rawUpdate.byteLength,
      };
      tempDoc.destroy();
    } catch { /* server download failed */ }

    return result;
  }

  /**
   * Build the HsmStateSnapshot for a document. Factored here so the CLI
   * and the Python RelayClient can both reach the same shape via a
   * single `__relayDebug.getHsmStateSnapshot(path)` call.
   */
  private async getHsmStateSnapshot(path: string): Promise<HsmStateSnapshot> {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) {
      throw new Error(`HSM not found: ${path}`);
    }
    const { doc, hsm, guid, folder, filePath } = lookup;

    const lca = (hsm as any)._lca;
    const hasValidLCA = !!(lca && lca.contents !== undefined && lca.meta?.hash);
    const lcaContent: string | null = hasValidLCA ? lca.contents : null;

    // Disk — prefer the vault adapter so we see exactly what the HSM sees.
    const vaultPath = (folder as any).path + filePath;
    let diskContent: string | null = null;
    try {
      diskContent = await this.plugin.app.vault.adapter.read(vaultPath);
    } catch {
      diskContent = null;
    }

    // IDB — prefer the in-memory localDoc so we don't open a parallel
    // IndexeddbPersistence when the HSM is warm.
    let idbContent: string | null = null;
    let idbStateVector: Uint8Array | null = null;
    if ((hsm as any).localDoc) {
      idbContent = (hsm as any).localDoc.getText('contents').toString();
      idbStateVector = (hsm as any)._localStateVector || null;
    } else {
      try {
        const result = await readIdbContent(
          guid,
          (hsm as any)._persistenceMetadata?.appId,
        );
        if (result) {
          idbContent = result.content;
          idbStateVector = result.stateVector;
        }
      } catch { /* noop */ }
    }

    // SV equality — only meaningful if both sides exist.
    let stateVectorsEqual: boolean | null = null;
    try {
      const remoteStateVector: Uint8Array | null =
        (hsm as any)._remoteStateVector || null;
      if (idbStateVector && remoteStateVector) {
        const localArr = Array.from(idbStateVector);
        const remoteArr = Array.from(remoteStateVector);
        stateVectorsEqual = JSON.stringify(localArr) === JSON.stringify(remoteArr);
      }
    } catch { /* noop */ }

    const diskMatchesIdb =
      diskContent !== null && idbContent !== null && diskContent === idbContent;
    const idbMatchesLca =
      idbContent !== null && lcaContent !== null && idbContent === lcaContent;

    // Recent transitions from the HSM disk log.
    let recentTransitions: HsmStateTransition[] = [];
    try {
      const entries = await getRecentEntries(guid, 10);
      recentTransitions = entries.map((raw: any) => ({
        ts: raw.ts,
        seq: raw.seq,
        event: typeof raw.event === 'object' ? raw.event.type : raw.event,
        from: raw.from,
        to: raw.to,
      }));
    } catch { /* noop */ }

    // Frontmatter Y.Map snapshot.
    let frontmatterMap: Record<string, any> | null = null;
    if ((hsm as any).localDoc) {
      try {
        const ymap = (hsm as any).localDoc.getMap('frontmatter');
        if (ymap.size > 0) {
          frontmatterMap = {};
          for (const [k, v] of ymap.entries()) {
            try { frontmatterMap[k] = JSON.parse(v as string); }
            catch { frontmatterMap[k] = v; }
          }
        }
      } catch { /* noop */ }
    }

    const syncGateRaw = (hsm as any)._syncGate;
    const syncGate: HsmSyncGate | null = syncGateRaw ? {
      providerConnected: !!syncGateRaw.providerConnected,
      providerSynced: !!syncGateRaw.providerSynced,
      localOnly: !!syncGateRaw.localOnly,
      pendingInbound: syncGateRaw.pendingInbound ?? 0,
      pendingOutbound: syncGateRaw.pendingOutbound ?? 0,
    } : null;

    void doc; // referenced for future expansion; silences lint

    return {
      path: filePath,
      guid,
      folder: (folder as any).name,
      statePath: (hsm as any)._statePath || 'unknown',
      syncGate,
      hasLCA: hasValidLCA,
      lcaHash: lca?.meta?.hash || null,
      lcaContentLength: lca?.contents?.length ?? null,
      lcaContent,
      hasConflict: !!(hsm as any).conflictData,
      conflictData: (hsm as any).conflictData || null,
      localDocLength: (hsm as any).localDoc
        ? ((hsm as any).localDoc.getText?.('contents')?.toString()?.length ?? 0)
        : 0,
      idbContent,
      diskMtime: (hsm as any)._disk?.mtime || null,
      diskContent,
      stateVectorsEqual,
      diskMatchesIdb,
      idbMatchesLca,
      frontmatterMap,
      recentTransitions,
    };
  }

  /**
   * Wait for an HSM to reach a state path that starts with `statePrefix`,
   * racing against a timeout. Thin bridge over `MergeHSM.awaitState`,
   * which is event-driven (subscribes to `stateChanges` and resolves
   * as soon as the predicate matches) — no polling, no per-tick
   * Python↔JS round-trips.
   *
   * Resolves with the final state path on success. Rejects with a
   * timeout error that includes the current state path for debugging.
   *
   * Use from the Python library to compose "open file and wait for
   * active" or "close and wait for idle" flows without baking the
   * wait into the action primitives themselves.
   */
  private async awaitHsmState(
    path: string,
    statePrefix: string,
    timeoutMs: number,
  ): Promise<string> {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const hsm = lookup.hsm as any;

    const matcher = (s: string) => s.startsWith(statePrefix);
    if (matcher(hsm._statePath)) return hsm._statePath;

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        hsm.awaitState(matcher),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `awaitHsmState timeout after ${timeoutMs}ms waiting for ` +
                  `${path} to reach state starting with "${statePrefix}" ` +
                  `(current: ${hsm._statePath})`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    return hsm._statePath;
  }

  /**
   * Build a focused conflict snapshot from a document's HSM. Exposes the
   * same `conflictData` that `getHsmStateSnapshot` already carries, in a
   * narrower shape so callers don't have to pull the full state dump.
   */
  /**
   * djb2-style 32-bit string hash, rendered as 8 hex chars. Not
   * cryptographic — just a cheap stable fingerprint for hunk content.
   * With 8 chars = 32 bits of entropy, collisions are negligible for
   * the handful of hunks a single file ever produces.
   */
  private hashString(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Given the full per-hunk hashes, find the minimum prefix length
   * that disambiguates every hunk — jj/git style. Minimum 2 chars for
   * readability even when a 1-char prefix would already be unique.
   */
  private minUniquePrefixLen(hashes: string[]): number {
    if (hashes.length <= 1) return 2;
    for (let len = 2; len <= 8; len++) {
      const seen = new Set<string>();
      let collided = false;
      for (const h of hashes) {
        const p = h.slice(0, len);
        if (seen.has(p)) { collided = true; break; }
        seen.add(p);
      }
      if (!collided) return len;
    }
    return 8; // full hash as fallback
  }

  private async getConflictInfo(path: string): Promise<ConflictInfoSnapshot> {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const { hsm, guid } = lookup;

    const cd = (hsm as any).conflictData || null;
    const regions = (cd?.conflictRegions as any[] | undefined) ?? [];
    const resolved = (cd?.resolvedIndices as Set<number> | undefined) ?? new Set<number>();

    const fullHashes = regions.map((r) =>
      this.hashString(`${r.oursContent}\0${r.theirsContent}`),
    );
    const prefixLen = this.minUniquePrefixLen(fullHashes);

    const hunks: ConflictHunkInfo[] = regions.map((r, index) => ({
      index,
      id: fullHashes[index].slice(0, prefixLen),
      baseStart: r.baseStart,
      baseEnd: r.baseEnd,
      resolved: resolved.has(index),
      oursContent: r.oursContent,
      theirsContent: r.theirsContent,
    }));

    return {
      path,
      guid,
      statePath: (hsm as any)._statePath || 'unknown',
      hasConflict: !!cd,
      base: cd?.base ?? null,
      ours: cd?.ours ?? null,
      theirs: cd?.theirs ?? null,
      oursLabel: cd?.oursLabel ?? null,
      theirsLabel: cd?.theirsLabel ?? null,
      hunks,
      hunkCount: regions.length,
      resolvedHunkCount: resolved.size,
    };
  }

  /**
   * Dispatch a `RESOLVE` event to the HSM with the chosen final content.
   * The state machine runs the `resolveConflict` action, which merges
   * remote CRDT into local, DMPs the chosen text onto localDoc, emits
   * DISPATCH_CM6 to the editor, and clears fork/conflict state. Returns
   * the state path after dispatch.
   */
  private async resolveConflict(path: string, contents: string): Promise<string> {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const hsm = lookup.hsm as any;

    hsm.send({ type: 'RESOLVE', contents });
    return hsm._statePath || 'unknown';
  }

  /**
   * Dispatch a single `RESOLVE_HUNK` event. `indexOrId` may be a
   * numeric array index (fast, session-local) or a string prefix of
   * the content-hash id (stable across re-parses; any unique prefix
   * is accepted, jj/git style). Unknown ids throw; ambiguous id
   * prefixes throw with the candidate list.
   */
  /**
   * Clear the HSM's LCA in place. Low-level internal-state mutation
   * that reproduces the no-LCA state after upgrading from a plugin
   * version without LCA tracking.
   */
  private async clearLca(path: string): Promise<void> {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    (lookup.hsm as any)._lca = null;
  }

  /**
   * Dispatch a simple parameter-less conflict event (OPEN_DIFF_VIEW,
   * CANCEL) to an HSM and return the resulting state path. Centralizes
   * the lookup + send boilerplate for single-event primitives.
   */
  private sendConflictEvent(path: string, event: { type: string }): string {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const hsm = lookup.hsm as any;
    hsm.send(event);
    return hsm._statePath || 'unknown';
  }

  private async resolveHunk(
    path: string,
    indexOrId: number | string,
    resolution: 'local' | 'remote' | 'both',
  ): Promise<string> {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const hsm = lookup.hsm as any;

    let index: number;
    if (typeof indexOrId === 'number') {
      index = indexOrId;
    } else {
      const cd = hsm.conflictData;
      if (!cd?.conflictRegions) {
        throw new Error(`No active conflict on ${path}`);
      }
      const regions = cd.conflictRegions as any[];
      const fullHashes = regions.map((r) =>
        this.hashString(`${r.oursContent}\0${r.theirsContent}`),
      );
      const matches: number[] = [];
      for (let i = 0; i < fullHashes.length; i++) {
        if (fullHashes[i].startsWith(indexOrId)) matches.push(i);
      }
      if (matches.length === 0) {
        throw new Error(
          `Hunk id ${JSON.stringify(indexOrId)} not found on ${path} ` +
            `(${regions.length} hunks present)`,
        );
      }
      if (matches.length > 1) {
        const candidates = matches
          .map((m) => `${fullHashes[m].slice(0, 6)}(index=${m})`)
          .join(', ');
        throw new Error(
          `Hunk id ${JSON.stringify(indexOrId)} is ambiguous on ${path} ` +
            `(${matches.length} candidates: ${candidates}) — use a longer prefix`,
        );
      }
      index = matches[0];
    }

    hsm.send({ type: 'RESOLVE_HUNK', index, resolution });
    return hsm._statePath || 'unknown';
  }

  /**
   * Shared helper: resolve a vault path to a lookup + dbName, so the
   * getIdb* methods don't each duplicate the prelude. Throws if the
   * document can't be found or has no persistence metadata.
   */
  private resolveIdbTarget(path: string): {
    hsm: any; guid: string; folder: any; filePath: string; dbName: string;
  } {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const lookup = (g as any).__relayDebug?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const { hsm, guid, folder, filePath } = lookup;
    const appId = (hsm as any)._persistenceMetadata?.appId;
    if (!appId) throw new Error('No appId in persistence metadata');
    return { hsm, guid, folder, filePath, dbName: `${appId}-relay-doc-${guid}` };
  }

  /**
   * Open an IndexedDB database by name and return the handle. Promise
   * rejects if the open request errors.
   */
  private openDb(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onerror = () => reject(new Error(`Failed to open DB: ${dbName}`));
      request.onsuccess = () => resolve(request.result);
    });
  }

  /**
   * Await an IDBRequest as a Promise.
   */
  private awaitRequest<T>(request: IDBRequest<T>, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(new Error(`Failed: ${label}`));
      request.onsuccess = () => resolve(request.result);
    });
  }

  /**
   * Snapshot the per-doc IndexedDB + compare against disk. Replaces the
   * ~100-line inline JS blob that used to live in cmd_relay_idb_content.
   */
  private async getIdbContent(path: string): Promise<IdbContentSnapshot> {
    const { hsm, guid, folder, filePath, dbName } = this.resolveIdbTarget(path);

    const db = await this.openDb(dbName);
    try {
      const tx = db.transaction(['updates', 'custom'], 'readonly');
      const updates = await this.awaitRequest(
        tx.objectStore('updates').getAll(),
        'read updates',
      );
      const customKeys = await this.awaitRequest(
        tx.objectStore('custom').getAllKeys(),
        'read custom keys',
      );
      const customValues = await this.awaitRequest(
        tx.objectStore('custom').getAll(),
        'read custom values',
      );
      const metadata: Record<string, any> = {};
      for (let i = 0; i < customKeys.length; i++) {
        metadata[String(customKeys[i])] = customValues[i];
      }

      // Prefer the in-memory localDoc text (matches the HSM's view).
      // When hibernated, fall back to opening IndexeddbPersistence via
      // readIdbContent.
      let idbContent: string | null = null;
      if ((hsm as any).localDoc) {
        idbContent = (hsm as any).localDoc.getText('contents').toString();
      } else {
        try {
          const result = await readIdbContent(guid, (hsm as any)._persistenceMetadata?.appId);
          if (result) idbContent = result.content;
        } catch { /* noop */ }
      }

      // Read disk for comparison.
      const vaultPath = (folder as any).path + filePath;
      let diskContent: string | null = null;
      try {
        diskContent = await this.plugin.app.vault.adapter.read(vaultPath);
      } catch (e: any) {
        diskContent = `[Error reading disk: ${e.message}]`;
      }

      return {
        path: filePath,
        guid,
        folder: (folder as any).name,
        dbName,
        metadata,
        updatesCount: updates.length,
        idbContent,
        idbLength: idbContent?.length ?? 0,
        diskContent,
        diskLength: diskContent?.length ?? null,
        match: diskContent === idbContent,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Snapshot the OpCapture history store for a document. Replaces the
   * ~90-line inline JS blob that used to live in cmd_relay_idb_history.
   */
  private async getIdbHistory(path: string): Promise<IdbHistorySnapshot> {
    const { hsm, guid, folder, filePath, dbName } = this.resolveIdbTarget(path);

    const db = await this.openDb(dbName);
    try {
      if (!db.objectStoreNames.contains('history')) {
        return {
          path: filePath,
          guid,
          folder: (folder as any).name,
          dbName,
          historyCount: 0,
          inMemoryCount: null,
          entries: [],
          note: 'No history store (DB version < 2)',
        };
      }

      const tx = db.transaction(['history'], 'readonly');
      const store = tx.objectStore('history');
      const keys = await this.awaitRequest(store.getAllKeys(), 'read history keys');
      const values = await this.awaitRequest(store.getAll(), 'read history values');

      const entries: IdbHistoryEntry[] = keys.map((key, i) => {
        const v = values[i] as any;
        return {
          key,
          origin: v.origin ?? null,
          timestamp: v.timestamp ?? null,
          time: v.timestamp ? new Date(v.timestamp).toISOString() : null,
          insertionsBytes: v.insertions?.byteLength ?? 0,
          deletionsBytes: v.deletions?.byteLength ?? 0,
        };
      });

      const persistence = (hsm as any)._persistenceMetadata?.persistence;
      const inMemoryCount = persistence?.opCapture?.entries?.length ?? null;

      return {
        path: filePath,
        guid,
        folder: (folder as any).name,
        dbName,
        historyCount: entries.length,
        inMemoryCount,
        entries,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Snapshot in-memory + persisted fork state for a document. Replaces
   * the ~90-line inline JS blob that used to live in cmd_relay_idb_fork.
   */
  private async getIdbFork(path: string): Promise<IdbForkSnapshot> {
    const { hsm, guid, folder, filePath } = this.resolveIdbTarget(path);

    const toSnapshot = (f: any): ForkSnapshot => ({
      base: f.base ?? null,
      baseLength: f.base?.length ?? 0,
      origin: f.origin ?? null,
      created: f.created ?? null,
      createdTime: f.created ? new Date(f.created).toISOString() : null,
      captureMark: f.captureMark ?? null,
      localStateVectorBytes: f.localStateVector?.byteLength ?? 0,
      remoteStateVectorBytes: f.remoteStateVector?.byteLength ?? 0,
    });

    const inMemoryFork = (hsm as any)._fork;
    const inMemory: ForkSnapshot | null = inMemoryFork ? toSnapshot(inMemoryFork) : null;

    // Read persisted fork from the shared HSM store. Swallow errors so
    // a broken IDB doesn't hide the in-memory snapshot the caller wants.
    let persistedFork: ForkSnapshot | { error: string } | null = null;
    let persistedMeta: IdbForkSnapshot['persistedMeta'] = null;
    try {
      const db = await this.openDb('RelayMergeHSM');
      try {
        if (db.objectStoreNames.contains('states')) {
          const tx = db.transaction(['states'], 'readonly');
          const state = await this.awaitRequest(
            tx.objectStore('states').get(guid),
            'read persisted state',
          ) as any;
          if (state?.fork) {
            persistedFork = toSnapshot(state.fork);
          }
          if (state) {
            persistedMeta = {
              lastStatePath: state.lastStatePath ?? null,
              persistedAt: state.persistedAt ?? null,
              persistedAtTime: state.persistedAt ? new Date(state.persistedAt).toISOString() : null,
              hasForkInPersistedState: !!state.fork,
            };
          }
        }
      } finally {
        db.close();
      }
    } catch (e: any) {
      persistedFork = { error: e.message };
    }

    return {
      path: filePath,
      guid,
      folder: (folder as any).name,
      statePath: (hsm as any)._statePath || 'unknown',
      hasFork: inMemoryFork != null,
      inMemoryFork: inMemory,
      persistedFork,
      persistedMeta,
    };
  }

  /**
   * Remove globals and dispose all bridges.
   * Call in plugin onunload().
   */
  destroy(): void {
    for (const bridge of this.bridges.values()) {
      bridge.dispose();
    }
    this.bridges.clear();
    this.activeRecordingName = null;

    const g = typeof window !== 'undefined' ? window : globalThis;
    delete (g as any).__relayDebug;
  }
}

// =============================================================================
// IDB Utility
// =============================================================================

async function readIdbContent(
  guid: string,
  appId: string,
): Promise<{ content: string; stateVector: Uint8Array } | null> {
  const dbName = `${appId}-relay-doc-${guid}`;
  const tempDoc = new Y.Doc();
  try {
    const persistence = new IndexeddbPersistence(dbName, tempDoc);
    await persistence.whenSynced;
    const content = tempDoc.getText('contents').toString();
    const stateVector = Y.encodeStateVector(tempDoc);
    await persistence.destroy();
    return { content, stateVector };
  } catch {
    tempDoc.destroy();
    return null;
  }
}
