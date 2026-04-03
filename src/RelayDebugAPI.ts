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
