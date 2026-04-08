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

/**
 * Rich snapshot of an HSM's state, covering every layer the test harness
 * routinely inspects: state path + sync gate (from the machine), LCA meta
 * and content (from the HSM), localDoc length/content/frontmatter (from
 * the in-memory Y.Doc), disk content + mtime (via the vault adapter), and
 * recent HSM transitions (via the disk log). Replaces the ad-hoc 120-line
 * eval blob that used to live in the Python CLI.
 */
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
