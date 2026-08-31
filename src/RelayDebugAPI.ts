/**
 * RelayDebugAPI — Plugin-level debug surface exposed as `window.__relayDebug`.
 *
 * Aggregates per-folder recording bridges and provides CDP-accessible
 * utilities for automated clients, live debugging, and diagnostics.
 *
 * Lifecycle: created in plugin onload(), destroyed in onunload().
 */

import * as Y from 'yjs';
import { TFile, View } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { diff_match_patch } from 'diff-match-patch';
import { IndexeddbPersistence } from './storage/y-indexeddb';
import type { TimeProvider } from './TimeProvider';
import type { E2ERecordingBridge, E2ERecordingState } from './merge-hsm/recording';
import type { ConflictInfoSnapshot } from './merge-hsm/conflict';
import { base64ToUint8Array, uint8ArrayToBase64 } from './merge-hsm/recording/serialization';
import { snapshotContains, snapshotFromDoc, snapshotsEqual, type YjsSnapshot } from './merge-hsm/snapshots';
import { getHSMBootId, getHSMBootEntries, flushHSMRecording, getRecentEntries, getSessionLogs } from './debug';
import type { SessionLogOptions } from './debug';
import { getRecentPromises } from './trackPromise';
import {
  buildFolderSyncStatusModel,
  type ActionableSyncFile,
  type FolderQueueSnapshot,
  type FolderSyncStatusModel,
  type QueueWorkItem,
} from './ui/SyncStatusModel';
import type { FolderSyncSnapshot } from './BackgroundSyncProgress';
import { Canvas, isCanvas } from './Canvas';
import type { CanvasData } from './CanvasView';
import type { ConflictData } from './merge-hsm/conflict';
import type Live from './main';
import type { SharedFolder } from './SharedFolder';
import type { MergeHSM } from './merge-hsm/MergeHSM';
import type { MergeManager, MergeManagerDocument } from './merge-hsm/MergeManager';
import type { RemoteEntityFile } from './BackgroundSync';
import { areCanvasDataEqual } from './CanvasData';

export type { ConflictHunkInfo, ConflictInfoSnapshot } from './merge-hsm/conflict';

// =============================================================================
// Types
// =============================================================================

export interface DocumentContentSnapshot {
  path: string;
  guid: string;
  folder: string;
  /** Live resident HSM localDoc text, captured after the asynchronous store probes. */
  local: { content: string; snapshot: string } | null;
  /** Live resident HSM remoteDoc text, captured after the asynchronous store probes. */
  remote: { content: string; snapshot: string } | null;
  /** Independently reconstructed per-document IndexedDB state. */
  idb: { content: string; snapshot: string } | null;
  /** Vault-adapter file contents and mtime. */
  disk: { content: string; mtime: number } | null;
  /** Independently downloaded and reconstructed server state. */
  server: { content: string; snapshot: string; updateSize: number } | null;
}

/**
 * Every representation of one canvas: the vault-facing localDoc, the
 * provider-facing remoteDoc, the .canvas file on disk, the open view (when
 * one shows this file), the server's own copy, and the machine posture.
 * Data payloads are CanvasData exports; equality flags use the
 * order-insensitive canvas comparison.
 */
/**
 * Every local representation of a canvas: both in-memory replicas, the file
 * on disk, an open view, the persisted machine record, and the equality flags
 * among them. Reads nothing over the network, so a probe may poll it.
 */
export interface CanvasStateSnapshot {
  path: string;
  guid: string;
  folder: string;
  statePath: string;
  connected: boolean;
  /** Whether the canvas was materialized before this probe ran. */
  wasMaterialized: boolean;
  userLock: boolean;
  downloadPending: boolean;
  local: { data: unknown; snapshot: string } | null;
  /** The provider-facing replica, held in memory alongside the local one. */
  remote: { data: unknown; snapshot: string } | null;
  disk: { data: unknown; mtime: number; parseError: boolean } | null;
  view: { data: unknown } | null;
  localRemoteContentEqual: boolean | null;
  diskMatchesLocal: boolean | null;
  viewMatchesLocal: boolean | null;
  lca: { present: boolean; diskHash: string | null; diskMtime: number | null };
  persisted: {
    lastStatePath: string;
    persistedAt: number;
    hasLca: boolean;
    hasLocalSnapshot: boolean;
  } | null;
  /** Ring buffer of recent machine transitions, oldest first. */
  recentTransitions: HsmStateTransition[];
}

/**
 * A state snapshot plus the server's own copy of the canvas. Obtaining the
 * server copy costs a full-state download, which is the same request the
 * sync machine issues, so asking for it attaches the canvas server side.
 * Read it deliberately; never poll it.
 */
export interface CanvasContentSnapshot extends CanvasStateSnapshot {
  server: { data: unknown; snapshot: string; updateSize: number } | null;
  serverMatchesLocal: boolean | null;
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
  metadata: Record<string, unknown>;
  updatesCount: number;
  idbContent: string | null;
  idbLength: number;
  diskContent: string | null;
  diskLength: number | null;
  match: boolean;
}

export interface IdbHistoryEntry {
  key: IDBValidKey;
  origin: unknown;
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
  captureMark: unknown;
  localSnapshotBytes: number;
  remoteSnapshotBytes: number;
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

export interface SyncPanelQueueSnapshot {
  isPaused: boolean;
  syncsQueued: number;
  syncsActive: number;
  downloadsQueued: number;
  downloadsActive: number;
  queued: number;
  active: number;
  total: number;
  runState: string;
  label: string;
  showSyncingCount: boolean;
  items: QueueWorkItem[];
}

export interface SyncPanelStatus {
  folderGuid: string;
  folderPath: string;
  snapshot: FolderSyncSnapshot;
  queue: SyncPanelQueueSnapshot;
  actionableFiles: ActionableSyncFile[];
}

/**
 * Rich snapshot of an HSM's state, covering state path and sync gate
 * (from the machine), LCA metadata and content (from the HSM), localDoc
 * content and frontmatter (from the in-memory Y.Doc), disk content and
 * mtime (via the vault adapter), and recent transitions (via the disk log).
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
  persistedLcaHash: string | null;
  persistedLcaContentLength: number | null;
  persistedLcaContent: string | null;
  persistedAt: number | null;
  hasConflict: boolean;
  conflictData: ConflictData | null;
  localDocLength: number;
  idbContent: string | null;
  diskMtime: number | null;
  diskContent: string | null;
  snapshotsEqual: boolean | null;
  diskMatchesIdb: boolean;
  idbMatchesLca: boolean;
  idbMatchesPersistedLca: boolean;
  frontmatterMap: Record<string, unknown> | null;
  recentTransitions: HsmStateTransition[];
}

// =============================================================================
// Global interface exposed via CDP
// =============================================================================

/**
 * A stable reference to an editor leaf. Resolved by matching windowId+leafId;
 * operations that require the leaf to still be showing the same file verify
 * `handle.path` against the leaf's current file.
 */
export interface EditorHandle {
  windowId: string;
  leafId: string;
  path: string;
}

export interface OpenEditorResult {
  handle: EditorHandle;
  viewType: string | null;
  mode: string | null;
}

export interface EditorInfo {
  handle: EditorHandle;
  /** The leaf's current file path. Differs from handle.path if the leaf drifted. Null if the leaf is gone. */
  currentPath: string | null;
  viewType: string | null;
  mode: string | null;
  active: boolean;
}

export interface EditorSnapshot {
  content: string;
  /** Base64-encoded Yjs snapshot of the active localDoc. Treat as opaque. */
  snapshot: string;
}

export interface SetEditorContentOptions {
  /** Base64 snapshot returned by captureEditorSnapshot. */
  base?: string;
}

export type SetEditorContentResult =
  | { success: true; changeCount: number }
  | { success: false; error: string };

/** The raw fork record read off a machine or its persisted state. */
interface DebugForkRaw {
  base?: string | null;
  origin?: string | null;
  created?: number | null;
  captureMark?: unknown;
  localSnapshot?: { byteLength?: number } | null;
  remoteSnapshot?: { byteLength?: number } | null;
}

/** The raw sync-gate posture read off a machine's bridge. */
interface DebugSyncGateRaw {
  providerSynced?: boolean;
  localOnly?: boolean;
  pendingInbound?: number;
  pendingOutbound?: number;
}

/** A resolved document lookup: the registry record, its machine, its home. */
export interface DebugDocumentLookup {
  doc: MergeManagerDocument;
  hsm: MergeHSM;
  guid: string;
  folder: SharedFolder;
  filePath: string;
}

export interface RelayDebugGlobal {
  /** Identity of the installing API instance; teardown removes only its own global. */
  __owner?: unknown;
  /** Register a recording bridge for the folder at PATH; returns its unsubscriber. */
  registerBridge?: (folderPath: string, bridge: E2ERecordingBridge) => () => void;
  /** Open PATH in an editor leaf. Pass `{ newLeaf: true }` to force a new tab. */
  openEditor: (path: string, opts?: { newLeaf?: boolean }) => Promise<OpenEditorResult>;
  /** Close the exact leaf identified by HANDLE. No-op if already gone. */
  closeEditor: (handle: EditorHandle) => Promise<void>;
  /** Read the editor text from the exact leaf. Throws if the leaf drifted. */
  getEditorContent: (handle: EditorHandle) => Promise<string>;
  /** Capture the editor text and an opaque localDoc snapshot for a later base-aware write. */
  captureEditorSnapshot: (handle: EditorHandle) => Promise<EditorSnapshot>;
  /** Inspect a handle without mutating focus or throwing on drift. */
  getEditorInfo: (handle: EditorHandle) => EditorInfo;
  /** Enumerate every open markdown editor leaf with its handle and state. */
  listEditors: () => EditorInfo[];
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
  /** Flush buffered recording entries to the vault-local JSONL file */
  flushRecording: () => Promise<void>;
  /** Get last N entries for a specific document (buffer + disk, newest files first) */
  getRecentEntries: (guid: string, limit?: number) => Promise<object[]>;
  /** Read Y.Doc text content from IndexedDB without waking the HSM */
  readIdbContent: (guid: string, appId: string) => Promise<{ content: string; snapshot: Uint8Array } | null>;
  /** Get plugin log entries from the current session, with optional level/pattern filtering */
  getSessionLogs: (options?: SessionLogOptions) => Promise<object[]>;
  /**
   * Get independent content views for a document. `local.content` is the
   * live HSM localDoc Y.Text; the IDB, disk, and server fields read their
   * named stores and may legitimately differ.
   */
  getDocumentContent: (path: string) => Promise<DocumentContentSnapshot>;
  /** Set the editor text via minimal CM6 transactions. Throws if the leaf drifted. */
  setEditorContent: (handle: EditorHandle, content: string, options?: SetEditorContentOptions) => Promise<SetEditorContentResult>;
  /** Look up a document by vault-level path including the shared-folder prefix (e.g. "/private/foo.md"). Returns document, HSM, folder, and GUID. */
  lookupDocument: (path: string) => DebugDocumentLookup | null;
  /** Look up a shared folder by path (e.g. "private"). Returns the SharedFolder or null. */
  lookupFolder: (path: string) => SharedFolder | null;
  /** Folder-scoped sync rows from MergeManager.syncStatus keyed by guid. */
  getFolderSyncStatus: (folderGuid: string) => { guid: string; path: string; status: string }[];
  /** Folder-scoped subset of sync rows where status === "error". */
  getFolderSyncErrors: (folderGuid: string) => { guid: string; path: string; status: string }[];
  /** Folder-scoped subset of sync rows where status === "conflict". */
  getFolderConflicts: (folderGuid: string) => { guid: string; path: string }[];
  /** All files currently in conflict state across every shared folder. */
  listAllConflicts: () => { folderGuid: string; folderPath: string; guid: string; path: string }[];
  getSyncPanelStatus: (folderGuid: string) => SyncPanelStatus;
  listSyncPanelStatus: () => SyncPanelStatus[];
  /** Get a rich HSM state snapshot: state path, LCA, disk, IDB, SV, frontmatter, and recent transitions. */
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
   * Snapshot every local representation of a canvas — localDoc, remoteDoc,
   * disk, open view — plus machine posture, LCA presence, and the persisted
   * record, with cross-representation equality flags. Reads nothing over the
   * network, so this is safe to poll. Reading the localDoc materializes a
   * hibernated canvas; pass `{ wake: false }` for a non-waking probe
   * (local/view come back null while hibernated).
   */
  getCanvasState: (path: string, options?: { wake?: boolean }) => Promise<CanvasStateSnapshot>;
  /**
   * The same snapshot plus the server's own copy of the canvas.
   *
   * Note: fetches remote server state. That download is the request the sync
   * machine issues, so it attaches the canvas server side — call it to settle
   * a question about the server, and poll `getCanvasState` instead.
   */
  getCanvasContent: (path: string) => Promise<CanvasContentSnapshot>;
  /**
   * Wait for a canvas machine to reach a state path that starts with
   * `statePrefix`. Thin bridge over `CanvasHSM.awaitState` — event-driven.
   */
  awaitCanvasState: (path: string, statePrefix: string, timeoutMs: number) => Promise<string>;
  /**
   * Focused conflict snapshot: base/ours/theirs plus labels so callers
   * can pick the right side by semantic name without pulling the whole
   * HsmStateSnapshot. Throws if the document is not found.
   */
  getConflictInfo: (path: string) => Promise<ConflictInfoSnapshot>;
  /**
   * Resolve the conflict with the chosen final content. Active conflicts use
   * the normal HSM event path; idle.diverged conflicts resolve headlessly
   * without opening editors or views.
   */
  resolveConflict: (path: string, contents: string) => Promise<string>;
  /**
   * Dispatch a `RESOLVE_HUNK` event for a single conflict hunk.
   *
   * `hunkId` is matched against `ConflictHunkInfo.id`; throws on
   * ambiguous (collision) or missing. Numeric array indices are not
   * accepted at this boundary because digit-only hash prefixes are valid ids.
   *
   * `resolution` picks the side to apply:
   *   - "ours"    → oursContent
   *   - "theirs"  → theirsContent
   *   - "both"    → oursContent + "\n" + theirsContent
   *   - "neither" → remove the hunk entirely
   *
   * The HSM mutates localDoc in place at the hunk's positioned region,
   * marks the hunk resolved, and once every hunk is resolved commits
   * the final content. idle.diverged conflicts resolve headlessly
   * without opening editors or views.
   */
  resolveHunk: (
    path: string,
    hunkId: string,
    resolution: 'ours' | 'theirs' | 'both' | 'neither',
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

  // -- Promise tracking --
  getPendingPromises: () => { label: string; ageMs: number; owner?: string }[];
  getRecentPromises: () => { label: string; created: number; settledAt: number; state: "fulfilled" | "rejected"; owner?: string }[];

  // -- Relay server CRUD --
  createRelay: (name: string) => Promise<{ guid: string; name: string }>;
  getRelayShareKey: (guid: string) => Promise<{ guid: string; name: string; key: string }>;
  acceptRelayShareKey: (key: string) => Promise<{ guid: string; name: string }>;
  renameRelay: (guid: string, newName: string) => Promise<{ guid: string; name: string }>;
  deleteRelay: (guid: string) => Promise<boolean>;
}

// =============================================================================
// RelayDebugAPI
// =============================================================================

/** Render an IndexedDB key as a metadata label. */
function idbKeyLabel(key: IDBValidKey): string {
  return typeof key === "string" || typeof key === "number"
    ? String(key)
    : JSON.stringify(key);
}

export class RelayDebugAPI {
  private bridges = new Map<string, E2ERecordingBridge>();
  private activeRecordingName: string | null = null;
  private plugin: Live | undefined;
  private destroyed = false;

  constructor(plugin?: Live) {
    this.plugin = plugin;
    this.installGlobal();
  }

  private debugWindow(): Window {
    return window;
  }

  /** The private machine internals the debug API reads. */
  private hsmInternals(hsm: MergeHSM): {
    _statePath?: string;
    _lca?: { meta?: { hash?: string | null }; contents?: string | null } | null;
    _disk?: { mtime?: number | null } | null;
    _localSnapshot?: Uint8Array | null;
    _remoteSnapshot?: Uint8Array | null;
    remoteDoc?: Y.Doc | null;
    _persistenceMetadata?: {
      appId?: string;
      persistence?: { opCapture?: { entries?: unknown[] } };
    };
    _fork?: DebugForkRaw;
    _syncGate?: DebugSyncGateRaw;
    _bridge?: { syncGate?: DebugSyncGateRaw; _syncGate?: DebugSyncGateRaw };
  } {
    return hsm as unknown as ReturnType<RelayDebugAPI['hsmInternals']>;
  }

  /** The private folder internals the debug API reads. */
  private folderInternals(folder: SharedFolder): {
    _hsmStore?: {
      loadState?: (guid: string) => Promise<{
        lca?: { hash?: string | null; contents?: unknown } | null;
        persistedAt?: number | null;
      } | null | undefined>;
    };
  } {
    return folder as unknown as ReturnType<RelayDebugAPI['folderInternals']>;
  }

  /** The attached plugin, or a loud failure when the API outlives it. */
  private requirePlugin(): Live {
    if (!this.plugin) throw new Error('Relay debug API has no attached plugin');
    return this.plugin;
  }

  /** Read the merge manager's private document registry. */
  private managedDoc(folder: SharedFolder, key: string): MergeManagerDocument | undefined {
    return (folder.mergeManager as unknown as {
      _getDocument?: (key: string) => MergeManagerDocument | undefined;
    })._getDocument?.(key);
  }

  private debugGlobal(): RelayDebugGlobal | undefined {
    return (this.debugWindow() as unknown as { __relayDebug?: RelayDebugGlobal }).__relayDebug;
  }

  /**
   * Register a per-folder recording bridge.
   * Returns a cleanup function to call when the folder is destroyed.
   */
  registerBridge(folderPath: string, bridge: E2ERecordingBridge): () => void {
    if (this.destroyed) {
      return () => {
        bridge.dispose();
      };
    }
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
      if (!this.destroyed) {
        this.installGlobal();
      }
    };
  }

  /**
   * Install the `window.__relayDebug` global.
   */
  private installGlobal(): void {
    if (this.destroyed) {
      if (this.debugGlobal()?.__owner === this) {
        delete (this.debugWindow() as unknown as { __relayDebug?: RelayDebugGlobal }).__relayDebug;
      }
      return;
    }

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
        const combined = recordings.flatMap((r): unknown[] => {
          try { return JSON.parse(r) as unknown[]; } catch { return []; }
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
      flushRecording: () => flushHSMRecording(),
      getRecentEntries: (guid, limit) => getRecentEntries(guid, limit),
      readIdbContent: readIdbContent,
      getSessionLogs: (options) => getSessionLogs(options),
      openEditor: (path, opts) => this.openEditor(path, opts),
      closeEditor: (handle) => this.closeEditor(handle),
      getEditorContent: (handle) => this.getEditorContent(handle),
      getEditorInfo: (handle) => this.getEditorInfo(handle),
      listEditors: () => this.listEditors(),
      getDocumentContent: async (path) => this.getDocumentContent(path),
      getCanvasState: async (path, options) => this.getCanvasState(path, options),
      getCanvasContent: async (path) => this.getCanvasContent(path),
      awaitCanvasState: async (path, statePrefix, timeoutMs) =>
        this.awaitCanvasState(path, statePrefix, timeoutMs),
      getHsmStateSnapshot: async (path) => this.getHsmStateSnapshot(path),
      getIdbContent: async (path) => this.getIdbContent(path),
      getIdbHistory: async (path) => this.getIdbHistory(path),
      getIdbFork: async (path) => this.getIdbFork(path),
      awaitHsmState: async (path, statePrefix, timeoutMs) =>
        this.awaitHsmState(path, statePrefix, timeoutMs),
      getConflictInfo: async (path) => this.getConflictInfo(path),
      resolveConflict: async (path, contents) => this.resolveConflict(path, contents),
      resolveHunk: async (path, hunkId, resolution) =>
        this.resolveHunk(path, hunkId, resolution),
      openDiffView: async (path) => this.sendConflictEvent(path, { type: 'OPEN_DIFF_VIEW' }),
      cancelDiffView: async (path) => this.sendConflictEvent(path, { type: 'CANCEL' }),
      clearLca: async (path) => this.clearLca(path),
      getPendingPromises: () => this.plugin?.promises?.getPending() ?? [],
      getRecentPromises: () => getRecentPromises(),

      createRelay: async (name) => {
        const relayManager = this.plugin?.relayManager;
        if (!relayManager) throw new Error('RelayManager not available');
        const relay = await relayManager.createRelay(name);
        return { guid: relay.guid, name: relay.name };
      },
      getRelayShareKey: async (guid) => {
        const relayManager = this.plugin?.relayManager;
        if (!relayManager) throw new Error('RelayManager not available');
        const relay = this.findRelayByGuid(guid);
        if (!relay) throw new Error(`Relay not found: ${guid}`);
        const invitation = await relayManager.getRelayInvitation(relay);
        if (!invitation?.key) throw new Error(`Relay invitation not found: ${guid}`);
        return { guid: relay.guid, name: relay.name, key: invitation.key };
      },
      acceptRelayShareKey: async (key) => {
        const relayManager = this.plugin?.relayManager;
        if (!relayManager) throw new Error('RelayManager not available');
        const relay = await relayManager.acceptInvitation(key);
        return { guid: relay.guid, name: relay.name };
      },
      renameRelay: async (guid, newName) => {
        const relayManager = this.plugin?.relayManager;
        if (!relayManager) throw new Error('RelayManager not available');
        const relay = this.findRelayByGuid(guid);
        if (!relay) throw new Error(`Relay not found: ${guid}`);
        relay.name = newName;
        await relayManager.updateRelay(relay);
        return { guid: relay.guid, name: relay.name };
      },
      deleteRelay: async (guid) => {
        const relayManager = this.plugin?.relayManager;
        if (!relayManager) throw new Error('RelayManager not available');
        const relay = this.findRelayByGuid(guid);
        if (!relay) throw new Error(`Relay not found: ${guid}`);
        return await relayManager.destroyRelay(relay);
      },

      captureEditorSnapshot: (handle) => this.captureEditorSnapshot(handle),
      setEditorContent: (handle, content, options) => this.setEditorContent(handle, content, options),

      lookupFolder: (path: string) => {
        const folders = this.plugin?.sharedFolders?.items() ?? [];
        for (const folder of folders) {
          if (folder.path === path) return folder;
        }
        // Also try matching as a prefix (e.g. "private" matches folder at path "private")
        for (const folder of folders) {
          if (path.startsWith(folder.path + '/')) return folder;
        }
        return null;
      },
      getFolderSyncStatus: (folderGuid: string) => this.getFolderSyncStatus(folderGuid),
      getFolderSyncErrors: (folderGuid: string) => this.getFolderSyncErrors(folderGuid),
      getFolderConflicts: (folderGuid: string) => this.getFolderConflicts(folderGuid),
      listAllConflicts: () => this.listAllConflicts(),
      getSyncPanelStatus: (folderGuid: string) => this.getSyncPanelStatus(folderGuid),
      listSyncPanelStatus: () => this.listSyncPanelStatus(),

      lookupDocument: (path: string) => this.lookupDocument(path),

    };

    (this.debugWindow() as unknown as { __relayDebug?: RelayDebugGlobal }).__relayDebug = {
      __owner: this,
      ...api,
      registerBridge: (folderPath: string, bridge: E2ERecordingBridge) => this.registerBridge(folderPath, bridge),
    };
  }

  /**
   * Look up a document by vault-level path including the shared-folder prefix
   * (e.g. "/private/foo.md"), or by bare GUID. Returns document, HSM, folder,
   * and GUID. Shared by the `window.__relayDebug` global and in-plugin debug
   * UI like the note state inspector.
   */
  lookupDocument(path: string): DebugDocumentLookup | null {
    const sharedFolders = this.plugin?.sharedFolders;
    if (!sharedFolders || !path) return null;
    if (!path.startsWith('/')) {
      for (const folder of sharedFolders.items()) {
        const doc = this.managedDoc(folder, path);
        const hsm = doc?.hsm;
        if (doc && hsm) return { doc, hsm, guid: path, folder, filePath: hsm.path || path };
      }
      throw new Error(`Document paths must start with '/' (got: ${JSON.stringify(path)})`);
    }
    const vaultPath = path.slice(1);
    const folder = sharedFolders.lookup(vaultPath);
    if (!folder) {
      const available = sharedFolders.items()
        .map((f) => '/' + f.path + '/')
        .join(', ') || '(none)';
      throw new Error(
        `Document path must be a vault-level path under a shared folder ` +
        `(got: ${JSON.stringify(path)}; shared folders: ${available})`
      );
    }
    const vpath = folder.getVirtualPath(vaultPath);
    const guid = folder.syncStore?.get(vpath);
    if (!guid) return null;
    const doc = this.managedDoc(folder, guid);
    const hsm = doc?.hsm;
    if (!doc || !hsm) return null;
    return { doc, hsm, guid, folder, filePath: hsm.path || vpath };
  }

  /**
   * Locate the leaf identified by HANDLE.windowId + HANDLE.leafId. Does NOT
   * verify the path — callers that require path match call resolveAndVerify.
   */
  private findLeaf(handle: EditorHandle): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.plugin?.app?.workspace?.iterateAllLeaves?.((leaf) => {
      if (found) return;
      const ids = this.leafIds(leaf);
      if (ids.windowId === handle.windowId && ids.leafId === handle.leafId) {
        found = leaf;
      }
    });
    return found;
  }

  /**
   * Resolve the exact leaf for HANDLE and verify it still shows handle.path.
   * Throws a precise error on every failure mode the caller cares about.
   */
  private resolveAndVerify(handle: EditorHandle): WorkspaceLeaf {
    const leaf = this.findLeaf(handle);
    if (!leaf) {
      throw new Error(`leaf not found: windowId=${handle.windowId} leafId=${handle.leafId}`);
    }
    const currentPath = this.leafInternals(leaf).view?.file?.path ?? null;
    if (currentPath !== handle.path) {
      throw new Error(`leaf drifted to ${currentPath ?? '<no file>'} (expected ${handle.path})`);
    }
    return leaf;
  }

  /**
   * Stable IDs for a leaf. Uses Obsidian's internal leaf.id and derives a
   * windowId from the leaf's root (main window vs popout).
   */
  /** The undocumented internals the debug API reads off a workspace leaf. */
  private leafInternals(leaf: WorkspaceLeaf): {
    id?: string;
    getRoot?: () => { id?: string } | undefined;
    view?: {
      getViewType?: () => string;
      getMode?: () => string;
      file?: { path?: string };
      containerEl?: HTMLElement;
      editor?: { getValue(): string; cm?: EditorView };
    };
  } {
    return leaf as unknown as ReturnType<RelayDebugAPI['leafInternals']>;
  }

  private leafIds(leaf: WorkspaceLeaf): { windowId: string; leafId: string } {
    const internals = this.leafInternals(leaf);
    const leafId: string = internals.id ?? '';
    const root = internals.getRoot?.();
    const rootId: string | undefined = root?.id;
    const mainRoot = this.plugin?.app?.workspace?.rootSplit;
    let windowId: string;
    if (!root || (root as unknown) === mainRoot) {
      windowId = 'main';
    } else if (rootId) {
      windowId = `popout:${rootId}`;
    } else {
      // Fallback: identify by the window containing the leaf's DOM.
      const ownerWin = internals.view?.containerEl?.ownerDocument?.defaultView;
      windowId = ownerWin && ownerWin !== window ? 'popout:unknown' : 'main';
    }
    return { windowId, leafId };
  }

  private leafViewInfo(leaf: WorkspaceLeaf): { viewType: string | null; mode: string | null; currentPath: string | null } {
    const view = this.leafInternals(leaf).view;
    return {
      viewType: view?.getViewType?.() ?? null,
      mode: view?.getMode?.() ?? null,
      currentPath: view?.file?.path ?? null,
    };
  }

  private findLeavesByPath(path: string): WorkspaceLeaf[] {
    const matches: WorkspaceLeaf[] = [];
    this.plugin?.app?.workspace?.iterateAllLeaves?.((leaf) => {
      if (this.leafInternals(leaf).view?.file?.path === path) {
        matches.push(leaf);
      }
    });
    return matches;
  }

  private async openEditor(
    path: string,
    opts?: { newLeaf?: boolean },
  ): Promise<OpenEditorResult> {
    const app = this.requirePlugin().app;
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }
    const leaf = app.workspace.getLeaf(opts?.newLeaf ? 'tab' : false);
    await leaf.openFile(file);
    app.workspace.setActiveLeaf?.(leaf, { focus: true });

    // Markdown views default to preview; flip to source so the editor is live.
    // setViewState is used instead of view.setMode because setMode expects a
    // mode instance (from view.modes), not a string — passing a string leaves
    // view.currentMode as the string and corrupts the view.
    const view = leaf.view as { getViewType?: () => string; getMode?: () => string } | undefined;
    if (view?.getViewType?.() === 'markdown' && view.getMode?.() !== 'source') {
      if (typeof leaf.setViewState === 'function') {
        const state = leaf.getViewState?.() ?? { type: 'markdown', state: {} };
        await leaf.setViewState({
          ...state,
          state: { ...(state.state || {}), file: path, mode: 'source' },
        }, { focus: true });
      }
    }

    // Let Obsidian finish any async view replacement caused by mode switches.
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const activeLeaf = app.workspace.getActiveViewOfType(View)?.leaf;
    const candidates = this.findLeavesByPath(path);
    const activeFile = (activeLeaf?.view as { file?: { path?: string } } | undefined)?.file;
    const resolvedLeaf = (
      (activeFile?.path === path ? activeLeaf : null)
      ?? candidates.find((candidate) => candidate === leaf)
      ?? candidates[0]
      ?? leaf
    );

    const ids = this.leafIds(resolvedLeaf);
    const info = this.leafViewInfo(resolvedLeaf);
    return {
      handle: { windowId: ids.windowId, leafId: ids.leafId, path },
      viewType: info.viewType,
      mode: info.mode,
    };
  }

  private getEditorInfo(handle: EditorHandle): EditorInfo {
    const leaf = this.findLeaf(handle);
    if (!leaf) {
      return {
        handle,
        currentPath: null,
        viewType: null,
        mode: null,
        active: false,
      };
    }
    const info = this.leafViewInfo(leaf);
    const active = this.plugin?.app?.workspace?.getActiveViewOfType(View)?.leaf === leaf;
    return {
      handle,
      currentPath: info.currentPath,
      viewType: info.viewType,
      mode: info.mode,
      active,
    };
  }

  private listEditors(): EditorInfo[] {
    const out: EditorInfo[] = [];
    const activeLeaf = this.plugin?.app?.workspace?.getActiveViewOfType(View)?.leaf;
    this.plugin?.app?.workspace?.iterateAllLeaves?.((leaf) => {
      const info = this.leafViewInfo(leaf);
      // Only markdown leaves have an editor; other view types can't be targeted
      // by editor commands, so listing them would just add noise.
      if (info.viewType !== 'markdown' || !info.currentPath) return;
      const ids = this.leafIds(leaf);
      out.push({
        handle: { windowId: ids.windowId, leafId: ids.leafId, path: info.currentPath },
        currentPath: info.currentPath,
        viewType: info.viewType,
        mode: info.mode,
        active: leaf === activeLeaf,
      });
    });
    return out;
  }

  private async getEditorContent(handle: EditorHandle): Promise<string> {
    const leaf = this.resolveAndVerify(handle);
    const editor = this.leafInternals(leaf).view?.editor;
    if (!editor) {
      throw new Error(`leaf has no editor: ${handle.path}`);
    }
    return editor.getValue();
  }

  private lookupLocalDocForEditorPath(path: string): Y.Doc {
    const lookupPath = path.startsWith('/') ? path : `/${path}`;
    const lookup = this.debugGlobal()?.lookupDocument?.(lookupPath);
    if (!lookup) {
      throw new Error(`Document not found for editor path: ${path}`);
    }
    const localDoc =
      lookup.hsm?.getLocalDoc?.() ??
      (lookup.doc as { localDoc?: Y.Doc | null }).localDoc;
    if (!localDoc) {
      throw new Error(`localDoc not available for editor path: ${path}`);
    }
    return localDoc;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async captureEditorSnapshot(handle: EditorHandle): Promise<EditorSnapshot> {
    const leaf = this.resolveAndVerify(handle);
    const editor = this.leafInternals(leaf).view?.editor;
    const cm = editor?.cm;
    if (!cm) {
      throw new Error(`leaf has no CM6 EditorView: ${handle.path}`);
    }

    const localDoc = this.lookupLocalDocForEditorPath(handle.path);
    const content = cm.state.doc.toString();
    const localText = localDoc.getText('contents').toString();
    if (content !== localText) {
      throw new Error(`editor text does not match localDoc for ${handle.path}`);
    }

    return {
      content,
      snapshot: uint8ArrayToBase64(snapshotFromDoc(localDoc).snapshot),
    };
  }

  private restoreLocalDocTextAtSnapshot(localDoc: Y.Doc, baseSnapshot: YjsSnapshot): string {
    const originDoc = new Y.Doc({ gc: false });
    let restoredDoc: Y.Doc | null = null;
    try {
      Y.applyUpdate(originDoc, Y.encodeStateAsUpdate(localDoc));
      restoredDoc = Y.createDocFromSnapshot(
        originDoc,
        Y.decodeSnapshot(baseSnapshot.snapshot),
      );
      if (!snapshotsEqual(snapshotFromDoc(restoredDoc), baseSnapshot)) {
        throw new Error('restored snapshot does not match requested snapshot');
      }
      return restoredDoc.getText('contents').toString();
    } finally {
      restoredDoc?.destroy();
      originDoc.destroy();
    }
  }

  private async setEditorContent(
    handle: EditorHandle,
    content: string,
    options?: SetEditorContentOptions,
  ): Promise<SetEditorContentResult> {
    const leaf = this.resolveAndVerify(handle);
    const editor = this.leafInternals(leaf).view?.editor;
    const cm = editor?.cm;
    if (!cm) return { success: false, error: 'leaf has no CM6 EditorView' };
    if (options?.base !== undefined && typeof options.base !== 'string') {
      return { success: false, error: 'base must be a snapshot string' };
    }

    const before = cm.state.doc.toString();
    const dmp = new diff_match_patch();
    let target = content;

    if (options?.base !== undefined) {
      let baseSnapshot: YjsSnapshot;
      let localDoc: Y.Doc;
      let baseText: string;

      try {
        baseSnapshot = { snapshot: base64ToUint8Array(options.base) };
        localDoc = this.lookupLocalDocForEditorPath(handle.path);

        const localText = localDoc.getText('contents').toString();
        if (before !== localText) {
          return { success: false, error: 'editor text does not match localDoc' };
        }

        const currentSnapshot = snapshotFromDoc(localDoc);
        if (!snapshotContains(currentSnapshot, baseSnapshot)) {
          return { success: false, error: 'base snapshot is not contained by current localDoc' };
        }

        baseText = this.restoreLocalDocTextAtSnapshot(localDoc, baseSnapshot);
      } catch (error) {
        return { success: false, error: `base snapshot could not be restored: ${this.errorMessage(error)}` };
      }

      if (baseText !== before) {
        const patches = dmp.patch_make(baseText, content);
        const [rebased, applied] = dmp.patch_apply(patches, before);
        if (!applied.every(Boolean)) {
          return { success: false, error: 'base snapshot patch no longer applies to editor' };
        }
        target = rebased;
      }
    }

    if (before === target) return { success: true, changeCount: 0 };

    const diffs = dmp.diff_main(before, target);
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
  }

  private async closeEditor(handle: EditorHandle): Promise<void> {
    const leaf = this.findLeaf(handle);
    if (leaf && this.leafInternals(leaf).view?.file?.path === handle.path) {
      leaf.detach?.();
      return;
    }

    // If the original leaf was rebuilt and its id drifted, close by path.
    const matches = this.findLeavesByPath(handle.path);
    if (matches.length === 0) return;
    for (const match of matches) {
      match.detach?.();
    }
  }

  /**
   * Encode a Uint8Array as a hex string for JSON serialization.
   */
  private toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get independent content views for a document. `local` and `remote` read
   * the resident HSM Y.Docs, `idb` reconstructs the per-document IndexedDB,
   * `disk` reads the vault adapter, and `server` downloads the remote update.
   * The live HSM views are captured last so the returned `local.content` is
   * exactly `hsm.getLocalDoc().getText('contents').toString()` at resolution
   * time, without EOL or trailing-newline normalization.
   */
  private async getDocumentContent(path: string): Promise<DocumentContentSnapshot> {
    const lookup = this.debugGlobal()?.lookupDocument?.(path);
    if (!lookup) throw new Error(`Document not found: ${path}`);
    const { doc, hsm, folder, guid, filePath } = lookup;

    const result: DocumentContentSnapshot = {
      path: this.toVaultPath(folder, filePath),
      guid,
      folder: folder.path || folder.name,
      local: null,
      remote: null,
      idb: null,
      disk: null,
      server: null,
    };

    // IDB
    try {
      const idbResult = await readIdbContent(guid, folder.appId, this.plugin?.timeProvider);
      if (idbResult) {
        result.idb = {
          content: idbResult.content,
          snapshot: this.toHex(idbResult.snapshot),
        };
      }
    } catch { /* IDB not available */ }

    // Disk
    try {
      const adapter = this.requirePlugin().app.vault.adapter;
      const vaultRelativePath = folder.getPath(filePath);
      const content = await adapter.read(vaultRelativePath);
      const stat = await adapter.stat(vaultRelativePath);
      result.disk = {
        content,
        mtime: stat?.mtime ?? 0,
      };
    } catch { /* disk read failed */ }

    // Server
    try {
      const response = await folder.backgroundSync.downloadItem(
        doc as unknown as RemoteEntityFile,
      );
      const rawUpdate = new Uint8Array(response.arrayBuffer);
      const tempDoc = new Y.Doc();
      Y.applyUpdate(tempDoc, rawUpdate);
      result.server = {
        content: tempDoc.getText('contents').toString(),
        snapshot: this.toHex(snapshotFromDoc(tempDoc).snapshot),
        updateSize: rawUpdate.byteLength,
      };
      tempDoc.destroy();
    } catch { /* server download failed */ }

    // Capture the live HSM docs after every asynchronous store probe. Reading
    // these before the awaits can return an internally consistent but stale
    // local snapshot when an edit lands while IDB/disk/server are being read.
    try {
      const localDoc = hsm.getLocalDoc();
      if (localDoc) {
        result.local = {
          content: localDoc.getText('contents').toString(),
          snapshot: this.toHex(snapshotFromDoc(localDoc).snapshot),
        };
      }
    } catch { /* localDoc not available */ }

    try {
      const remoteDoc = hsm.getRemoteDoc();
      if (remoteDoc) {
        result.remote = {
          content: remoteDoc.getText('contents').toString(),
          snapshot: this.toHex(snapshotFromDoc(remoteDoc).snapshot),
        };
      }
    } catch { /* remoteDoc not available */ }

    return result;
  }

  /**
   * Resolve the Canvas owning a vault-level path. Resolves through the
   * folder's membership map so a member without a file on disk (a canvas
   * awaiting materialization) is still reachable.
   */
  private lookupCanvas(path: string): { canvas: Canvas; folder: SharedFolder; guid: string } {
    let owner: SharedFolder | null = null;
    if (this.plugin?.sharedFolders) {
      for (const folder of this.plugin.sharedFolders.items()) {
        if (path.startsWith(folder.path + '/')) {
          owner = folder;
          break;
        }
      }
    }
    if (!owner) throw new Error(`No shared folder owns: ${path}`);
    const vpath = path.slice(owner.path.length);
    const guid = owner.syncStore.get(vpath);
    if (!guid) throw new Error(`Canvas not in folder membership: ${path}`);
    let canvas: import('./IFile').IFile | null | undefined = owner.files.get(guid);
    if (!canvas) {
      const tfile = this.requirePlugin().app.vault.getAbstractFileByPath(path);
      if (tfile) canvas = owner.getFile(tfile);
    }
    if (!isCanvas(canvas)) {
      throw new Error(`Not a canvas: ${path}`);
    }
    return { canvas, folder: owner, guid };
  }

  /**
   * Snapshot every representation of a canvas plus machine posture and
   * cross-representation equality flags. See CanvasContentSnapshot.
   */
  private async getCanvasState(
    path: string,
    options?: { wake?: boolean },
  ): Promise<CanvasStateSnapshot> {
    const { canvas, folder, guid } = this.lookupCanvas(path);
    const wake = options?.wake ?? true;
    const wasMaterialized = !!canvas.isMaterialized;
    const machine = canvas.hsm.getSnapshot();

    const result: CanvasStateSnapshot = {
      path,
      guid,
      folder: folder.path || folder.name,
      statePath: machine.statePath,
      connected: !!canvas.connected,
      wasMaterialized,
      userLock: !!machine.userLock,
      downloadPending: !!machine.downloadPending,
      local: null,
      remote: null,
      disk: null,
      view: null,
      localRemoteContentEqual: null,
      diskMatchesLocal: null,
      viewMatchesLocal: null,
      lca: {
        present: !!machine.hasLCA,
        diskHash: machine.disk?.hash ?? null,
        diskMtime: machine.disk?.mtime ?? null,
      },
      persisted: null,
      recentTransitions: machine.recentTransitions ?? [],
    };

    // Local doc (materializes a hibernated canvas unless wake === false)
    try {
      if (wake || wasMaterialized) {
        const localDoc = canvas.localDoc;
        result.local = {
          data: Canvas.exportCanvasData(localDoc),
          snapshot: this.toHex(snapshotFromDoc(localDoc).snapshot),
        };
      }
    } catch { /* localDoc not available */ }

    // Remote doc (provider-facing)
    try {
      const remoteDoc = canvas.ydoc;
      if (remoteDoc) {
        result.remote = {
          data: Canvas.exportCanvasData(remoteDoc),
          snapshot: this.toHex(snapshotFromDoc(remoteDoc).snapshot),
        };
      }
    } catch { /* remoteDoc not available */ }

    // Disk
    try {
      const adapter = this.requirePlugin().app.vault.adapter;
      const raw = await adapter.read(path);
      const stat = await adapter.stat(path);
      try {
        const parsed = (raw.trim().length > 0 ? JSON.parse(raw) : {}) as {
          nodes?: unknown[];
          edges?: unknown[];
        };
        result.disk = {
          data: { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] },
          mtime: stat?.mtime ?? 0,
          parseError: false,
        };
      } catch {
        result.disk = { data: null, mtime: stat?.mtime ?? 0, parseError: true };
      }
    } catch { /* no file on disk */ }

    // Open view (when a canvas leaf shows this file)
    try {
      this.requirePlugin().app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as {
          getViewType?: () => string;
          file?: { path?: string };
          canvas?: { getData: () => { nodes?: unknown[]; edges?: unknown[] } };
        } | undefined;
        if (view?.getViewType?.() === 'canvas' && view.file?.path === path) {
          const data = view.canvas?.getData();
          result.view = {
            data: { nodes: data?.nodes ?? [], edges: data?.edges ?? [] },
          };
        }
      });
    } catch { /* view not readable */ }

    // Persisted machine record
    try {
      const record = await folder.loadCanvasState(guid);
      if (record) {
        result.persisted = {
          lastStatePath: record.lastStatePath,
          persistedAt: record.persistedAt,
          hasLca: record.lca != null,
          hasLocalSnapshot: record.localSnapshot != null,
        };
      }
    } catch { /* persisted record not readable */ }

    const eq = (a: unknown, b: unknown) =>
      areCanvasDataEqual(
        a as CanvasData | null | undefined,
        b as CanvasData | null | undefined,
      );
    if (result.local && result.remote) {
      result.localRemoteContentEqual = eq(result.local.data, result.remote.data);
    }
    if (result.local && result.disk && !result.disk.parseError) {
      result.diskMatchesLocal = eq(result.disk.data, result.local.data);
    }
    if (result.local && result.view) {
      result.viewMatchesLocal = eq(result.view.data, result.local.data);
    }

    return result;
  }

  /**
   * A canvas's state snapshot together with the server's copy.
   *
   * Downloading the server copy is the same full-state request the sync
   * machine issues, so it attaches the canvas server side: this is a
   * participant's read, not an observer's. Call it to settle a question about
   * the server; poll getCanvasState instead.
   */
  private async getCanvasContent(path: string): Promise<CanvasContentSnapshot> {
    const { canvas, folder } = this.lookupCanvas(path);
    const result: CanvasContentSnapshot = {
      ...(await this.getCanvasState(path)),
      server: null,
      serverMatchesLocal: null,
    };

    try {
      const response = await folder.backgroundSync.downloadItem(canvas);
      const rawUpdate = new Uint8Array(response.arrayBuffer);
      const tempDoc = new Y.Doc();
      Y.applyUpdate(tempDoc, rawUpdate);
      result.server = {
        data: Canvas.exportCanvasData(tempDoc),
        snapshot: this.toHex(snapshotFromDoc(tempDoc).snapshot),
        updateSize: rawUpdate.byteLength,
      };
      tempDoc.destroy();
    } catch { /* server download failed */ }

    if (result.local && result.server) {
      result.serverMatchesLocal = areCanvasDataEqual(
        result.server.data as CanvasData | null | undefined,
        result.local.data as CanvasData | null | undefined,
      );
    }

    return result;
  }

  private async awaitCanvasState(
    path: string,
    statePrefix: string,
    timeoutMs: number,
  ): Promise<string> {
    const { canvas } = this.lookupCanvas(path);
    return canvas.hsm.awaitState(
      (statePath: string) => statePath.startsWith(statePrefix),
      timeoutMs,
    );
  }

  /**
   * Build the HsmStateSnapshot for a document so every debug-API caller
   * receives the same shape.
   */
  async getHsmStateSnapshot(path: string): Promise<HsmStateSnapshot> {
    const lookup = this.lookupDocument(path);
    if (!lookup) {
      throw new Error(`HSM not found: ${path}`);
    }
    const { doc, hsm, guid, folder, filePath } = lookup;

    const internals = this.hsmInternals(hsm);
    const localYDoc = hsm.getLocalDoc();

    // Disk — prefer the vault adapter so we see exactly what the HSM sees.
    const vaultPath = folder.path + filePath;
    let diskContent: string | null = null;
    try {
      diskContent = await this.requirePlugin().app.vault.adapter.read(vaultPath);
    } catch {
      diskContent = null;
    }

    // IDB — prefer the in-memory localDoc so we don't open a parallel
    // IndexeddbPersistence when the HSM is warm.
    let idbContent: string | null = null;
    let idbSnapshot: Uint8Array | null = null;
    if (localYDoc) {
      idbContent = localYDoc.getText('contents').toString();
      idbSnapshot = internals._localSnapshot || null;
    } else {
      try {
        const result = await readIdbContent(
          guid,
          internals._persistenceMetadata?.appId ?? '',
          this.plugin?.timeProvider,
        );
        if (result) {
          idbContent = result.content;
          idbSnapshot = result.snapshot;
        }
      } catch { /* noop */ }
    }

    // Head equality — only meaningful if both sides exist. Warm docs are
    // compared by freshly captured snapshots: the HSM's cached _localSnapshot
    // and _remoteSnapshot fields only refresh at lifecycle points and go
    // stale during active editing, reporting mismatch on converged docs.
    // Hibernated docs fall back to the cached/persisted heads, which is
    // the persistence-level check needed while the document is idle.
    let headSnapshotsEqual: boolean | null = null;
    try {
      if (localYDoc && internals.remoteDoc) {
        headSnapshotsEqual = snapshotsEqual(
          snapshotFromDoc(localYDoc),
          snapshotFromDoc(internals.remoteDoc),
        );
      } else {
        const remoteSnapshot: Uint8Array | null =
          internals._remoteSnapshot || null;
        if (idbSnapshot && remoteSnapshot) {
          headSnapshotsEqual = snapshotsEqual(
            { snapshot: idbSnapshot },
            { snapshot: remoteSnapshot },
          );
        }
      }
    } catch { /* noop */ }

    // Recent transitions from the HSM disk log.
    let recentTransitions: HsmStateTransition[] = [];
    try {
      const entries = (await getRecentEntries(guid, 10)) as Array<{
        ts: number;
        seq: number;
        event: { type: string } | string;
        from: string;
        to: string;
      }>;
      recentTransitions = entries.map((raw) => ({
        ts: raw.ts,
        seq: raw.seq,
        event: typeof raw.event === 'object' ? raw.event.type : raw.event,
        from: raw.from,
        to: raw.to,
      }));
    } catch { /* noop */ }

    // Frontmatter Y.Map snapshot.
    let frontmatterMap: Record<string, unknown> | null = null;
    if (localYDoc) {
      try {
        const ymap = localYDoc.getMap('frontmatter');
        if (ymap.size > 0) {
          frontmatterMap = {};
          for (const [k, v] of ymap.entries()) {
            try { frontmatterMap[k] = JSON.parse(v as string); }
            catch { frontmatterMap[k] = v; }
          }
        }
      } catch { /* noop */ }
    }

    // Durable HSM state. Clean hibernated HSMs keep LCA metadata resident but
    // may compact the contents body after persisting it to HSMStore.
    let persistedLcaHash: string | null = null;
    let persistedLcaContent: string | null = null;
    let persistedAt: number | null = null;
    try {
      const persistedState = await this.folderInternals(folder)._hsmStore?.loadState?.(guid);
      const persistedLca = persistedState?.lca ?? null;
      if (persistedLca) {
        persistedLcaHash = persistedLca.hash ?? null;
        persistedLcaContent =
          typeof persistedLca.contents === 'string'
            ? persistedLca.contents
            : null;
      }
      persistedAt =
        typeof persistedState?.persistedAt === 'number'
          ? persistedState.persistedAt
          : null;
    } catch { /* persisted HSM state unavailable */ }

    // Capture volatile in-memory HSM fields together after the async reads
    // above. Initial enrollment can complete while disk/IDB/log probes await.
    const lca = internals._lca;
    const hasValidLCA = !!(lca && lca.contents !== undefined && lca.meta?.hash);
    const lcaContent: string | null = hasValidLCA ? (lca?.contents ?? null) : null;
    const localDoc = localYDoc;
    const statePath = internals._statePath || 'unknown';
    const disk = internals._disk;
    const syncGateRaw =
      internals._syncGate ||
      internals._bridge?.syncGate ||
      internals._bridge?._syncGate;
    const syncGate: HsmSyncGate | null = syncGateRaw ? {
      providerConnected: !!(doc as { connected?: boolean } | undefined)?.connected,
      providerSynced: !!syncGateRaw.providerSynced,
      localOnly: !!syncGateRaw.localOnly,
      pendingInbound: syncGateRaw.pendingInbound ?? 0,
      pendingOutbound: syncGateRaw.pendingOutbound ?? 0,
    } : null;
    const diskMatchesIdb =
      diskContent !== null && idbContent !== null && diskContent === idbContent;
    const idbMatchesLca =
      idbContent !== null && lcaContent !== null && idbContent === lcaContent;
    const idbMatchesPersistedLca =
      idbContent !== null &&
      persistedLcaContent !== null &&
      idbContent === persistedLcaContent;

    return {
      path: this.toVaultPath(folder, filePath),
      guid,
      folder: folder.name,
      statePath,
      syncGate,
      hasLCA: hasValidLCA,
      lcaHash: lca?.meta?.hash || null,
      lcaContentLength: lca?.contents?.length ?? null,
      lcaContent,
      persistedLcaHash,
      persistedLcaContentLength: persistedLcaContent?.length ?? null,
      persistedLcaContent,
      persistedAt,
      hasConflict: !!hsm.getConflictData(),
      conflictData: hsm.getConflictData() || null,
      localDocLength: localDoc
        ? (localDoc.getText?.('contents')?.toString()?.length ?? 0)
        : 0,
      idbContent,
      diskMtime: disk?.mtime || null,
      diskContent,
      snapshotsEqual: headSnapshotsEqual,
      diskMatchesIdb,
      idbMatchesLca,
      idbMatchesPersistedLca,
      frontmatterMap,
      recentTransitions,
    };
  }

  /**
   * Wait for an HSM to reach a state path that starts with `statePrefix`,
   * racing against a timeout. Thin bridge over `MergeHSM.awaitState`,
   * which is event-driven (subscribes to `stateChanges` and resolves
   * as soon as the predicate matches) — no polling or per-tick calls.
   *
   * Resolves with the final state path on success. Rejects with a
   * timeout error that includes the current state path for debugging.
   *
   * Callers can compose "open file and wait for active" or "close and
   * wait for idle" flows without baking the wait into action primitives.
   */
  private async awaitHsmState(
    path: string,
    statePrefix: string,
    timeoutMs: number,
  ): Promise<string> {
    const lookup = this.debugGlobal()?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const hsm = lookup.hsm;
    const internals = this.hsmInternals(hsm);

    const matcher = (s: string) => s.startsWith(statePrefix);
    const current = internals._statePath ?? '';
    if (matcher(current)) return current;

    let timer: number | null = null;
    try {
      await Promise.race([
        hsm.awaitState(matcher),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => {
            reject(
              new Error(
                `awaitHsmState timeout after ${timeoutMs}ms waiting for ` +
                  `${path} to reach state starting with "${statePrefix}" ` +
                  `(current: ${this.hsmInternals(hsm)._statePath})`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
    return this.hsmInternals(hsm)._statePath ?? 'unknown';
  }

  /**
   * Conflict APIs translate vault paths into merge-layer targets. State,
   * hunk lookup, waking, and mutation behavior live below this boundary.
   */
  private resolveConflictTarget(path: string): { manager: MergeManager; guid: string; folder: SharedFolder; filePath: string } {
    const lookup = this.debugGlobal()?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const manager = lookup.folder?.mergeManager;
    if (!manager) throw new Error(`Merge manager not found: ${path}`);
    return {
      manager,
      guid: lookup.guid,
      folder: lookup.folder,
      filePath: lookup.filePath,
    };
  }

  private async getConflictInfo(path: string): Promise<ConflictInfoSnapshot> {
    const { manager, guid, folder, filePath } = this.resolveConflictTarget(path);
    if (typeof manager.getConflictInfo !== 'function') {
      throw new Error(`Conflict info is not available: ${path}`);
    }
    const info = await manager.getConflictInfo(guid);
    return {
      ...info,
      path: this.toVaultPath(folder, filePath),
    };
  }

  private async resolveConflict(path: string, contents: string): Promise<string> {
    const { manager, guid } = this.resolveConflictTarget(path);
    if (typeof manager.resolveConflict !== 'function') {
      throw new Error(`Conflict resolution is not available: ${path}`);
    }
    return manager.resolveConflict(guid, contents);
  }

  /**
   * Clear the HSM's LCA in place. Low-level internal-state mutation
   * that reproduces the no-LCA state after upgrading from a plugin
   * version without LCA tracking.
   */
  private findRelayByGuid(guid: string) {
    for (const r of this.requirePlugin().relayManager.relays.values()) {
      if (r.guid === guid) return r;
    }
    return null;
  }

  /** Resolve a shared folder by exact path or path prefix. */
  private resolveFolder(path: string): SharedFolder | null {
    if (!this.plugin?.sharedFolders) return null;
    for (const folder of this.plugin.sharedFolders.items()) {
      if (folder.path === path) return folder;
    }
    for (const folder of this.plugin.sharedFolders.items()) {
      if (path.startsWith(folder.path + '/')) return folder;
    }
    return null;
  }

  private getFolderByGuid(folderGuid: string): SharedFolder | null {
    if (!this.plugin?.sharedFolders) return null;
    for (const folder of this.plugin.sharedFolders.items()) {
      if (folder.guid === folderGuid) return folder;
    }
    return null;
  }

  /**
   * Canonical vault-path form: leading-slash, includes the shared-folder
   * prefix (e.g. `/private/foo.md`). All debug-API outputs emit paths in
   * this shape so output can round-trip through any path-accepting call.
   */
  private toVaultPath(folder: SharedFolder, vpath: string): string {
    return '/' + folder.getPath(vpath);
  }

  private getFolderSyncStatus(folderGuid: string): { guid: string; path: string; status: string }[] {
    const folder = this.getFolderByGuid(folderGuid);
    const mm = folder?.mergeManager;
    if (!folder || !mm?.syncStatus) return [];

    const rows: { guid: string; path: string; status: string }[] = [];
    for (const [guid, syncStatus] of mm.syncStatus.entries()) {
      const document = this.managedDoc(folder, guid);
      const candidate = folder.files?.get(guid);
      const file = (document as { path?: string } | undefined) ?? (isCanvas(candidate) ? candidate : undefined);
      const vpath = file?.path;
      rows.push({
        guid,
        path: vpath ? this.toVaultPath(folder, vpath) : guid,
        status: syncStatus?.status ?? 'unknown',
      });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    return rows;
  }

  private getFolderSyncErrors(folderGuid: string): { guid: string; path: string; status: string }[] {
    return this.getFolderSyncStatus(folderGuid).filter((row) => row.status === 'error');
  }

  private getFolderConflicts(folderGuid: string): { guid: string; path: string }[] {
    return this.getFolderSyncStatus(folderGuid)
      .filter((row) => row.status === 'conflict')
      .map(({ guid, path }) => ({ guid, path }));
  }

  private listAllConflicts(): { folderGuid: string; folderPath: string; guid: string; path: string }[] {
    if (!this.plugin?.sharedFolders) return [];
    const out: { folderGuid: string; folderPath: string; guid: string; path: string }[] = [];
    for (const folder of this.plugin.sharedFolders.items()) {
      const folderGuid = folder.guid;
      const folderPath = folder.path ?? '';
      for (const row of this.getFolderConflicts(folderGuid)) {
        out.push({ folderGuid, folderPath, guid: row.guid, path: row.path });
      }
    }
    return out;
  }

  private getSyncPanelStatus(folderGuid: string): SyncPanelStatus {
    const folder = this.getFolderByGuid(folderGuid);
    if (!folder) {
      throw new Error(`Folder not found: ${folderGuid}`);
    }
    return this.serializeSyncPanelStatus(folder, buildFolderSyncStatusModel(folder));
  }

  private listSyncPanelStatus(): SyncPanelStatus[] {
    if (!this.plugin?.sharedFolders) return [];
    const panels: SyncPanelStatus[] = [];
    for (const folder of this.plugin.sharedFolders.items()) {
      panels.push(this.serializeSyncPanelStatus(folder, buildFolderSyncStatusModel(folder)));
    }
    panels.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
    return panels;
  }

  private serializeSyncPanelStatus(folder: SharedFolder, model: FolderSyncStatusModel): SyncPanelStatus {
    const queue = this.serializeSyncPanelQueue(folder, model.queue);
    return {
      folderGuid: folder.guid,
      folderPath: folder.path ?? '',
      snapshot: { ...model.snapshot },
      queue,
      actionableFiles: model.actionableFiles.map((file) => ({
        ...file,
        path: this.toPanelVaultPath(folder, file.path),
      })),
    };
  }

  private serializeSyncPanelQueue(folder: SharedFolder, queue: FolderQueueSnapshot): SyncPanelQueueSnapshot {
    const byId = new Map<string, QueueWorkItem>();
    for (const item of queue.itemsByGuid.values()) {
      byId.set(`${item.guid}:${item.kind}:${item.phase}`, {
        ...item,
        path: this.toPanelVaultPath(folder, item.path),
      });
    }
    const items = Array.from(byId.values()).sort((a, b) => {
      const pathOrder = a.path.localeCompare(b.path);
      if (pathOrder !== 0) return pathOrder;
      return `${a.kind}:${a.phase}`.localeCompare(`${b.kind}:${b.phase}`);
    });
    return {
      isPaused: queue.isPaused,
      syncsQueued: queue.syncsQueued,
      syncsActive: queue.syncsActive,
      downloadsQueued: queue.downloadsQueued,
      downloadsActive: queue.downloadsActive,
      queued: queue.queued,
      active: queue.active,
      total: queue.total,
      runState: queue.runState,
      label: queue.label,
      showSyncingCount: queue.showSyncingCount,
      items,
    };
  }

  private toPanelVaultPath(folder: SharedFolder, path: string): string {
    if (!path) return path;
    const withoutSlash = path.replace(/^\/+/, '');
    const folderPath = String(folder.path ?? '').replace(/^\/+/, '');
    if (folderPath && (withoutSlash === folderPath || withoutSlash.startsWith(`${folderPath}/`))) {
      return `/${withoutSlash}`;
    }
    return this.toVaultPath(folder, withoutSlash);
  }

  private async clearLca(path: string): Promise<void> {
    const lookup = this.debugGlobal()?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    this.hsmInternals(lookup.hsm)._lca = null;
  }

  /**
   * Dispatch a simple parameter-less conflict event (OPEN_DIFF_VIEW,
   * CANCEL) to an HSM and return the resulting state path. Centralizes
   * the lookup + send boilerplate for single-event primitives.
   */
  private sendConflictEvent(path: string, event: { type: string }): string {
    const lookup = this.debugGlobal()?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const hsm = lookup.hsm;
    hsm.send(event as Parameters<MergeHSM['send']>[0]);
    return this.hsmInternals(hsm)._statePath || 'unknown';
  }

  private async resolveHunk(
    path: string,
    hunkId: string,
    resolution: 'ours' | 'theirs' | 'both' | 'neither',
  ): Promise<string> {
    const { manager, guid } = this.resolveConflictTarget(path);
    if (typeof manager.resolveConflictHunk !== 'function') {
      throw new Error(`Conflict hunk resolution is not available: ${path}`);
    }
    return manager.resolveConflictHunk(guid, hunkId, resolution);
  }

  /**
   * Shared helper: resolve a vault path to a lookup + dbName, so the
   * getIdb* methods don't each duplicate the prelude. Throws if the
   * document can't be found or has no persistence metadata.
   */
  private resolveIdbTarget(path: string): {
    hsm: MergeHSM; guid: string; folder: SharedFolder; filePath: string; dbName: string; hsmDbName: string;
  } {
    const lookup = this.debugGlobal()?.lookupDocument?.(path);
    if (!lookup) throw new Error(`HSM not found: ${path}`);
    const { hsm, guid, folder, filePath } = lookup;
    const appId = this.hsmInternals(hsm)._persistenceMetadata?.appId;
    if (!appId) throw new Error('No appId in persistence metadata');
    return {
      hsm,
      guid,
      folder,
      filePath,
      dbName: `${appId}-relay-doc-${guid}`,
      hsmDbName: `${appId}-relay-hsm`,
    };
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
   * Snapshot the per-document IndexedDB state and compare it against disk.
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
      const metadata: Record<string, unknown> = {};
      for (let i = 0; i < customKeys.length; i++) {
        metadata[idbKeyLabel(customKeys[i])] = customValues[i];
      }

      // Prefer the in-memory localDoc text (matches the HSM's view).
      // When hibernated, fall back to opening IndexeddbPersistence via
      // readIdbContent.
      let idbContent: string | null = null;
      const localYDoc = hsm.getLocalDoc();
      if (localYDoc) {
        idbContent = localYDoc.getText('contents').toString();
      } else {
        try {
          const result = await readIdbContent(guid, this.hsmInternals(hsm)._persistenceMetadata?.appId ?? '', this.plugin?.timeProvider);
          if (result) idbContent = result.content;
        } catch { /* noop */ }
      }

      // Read disk for comparison.
      const vaultPath = folder.path + filePath;
      let diskContent: string | null = null;
      try {
        diskContent = await this.requirePlugin().app.vault.adapter.read(vaultPath);
      } catch (e) {
        diskContent = `[Error reading disk: ${e instanceof Error ? e.message : String(e)}]`;
      }

      return {
        path: this.toVaultPath(folder, filePath),
        guid,
        folder: folder.name,
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
   * Snapshot the OpCapture history store for a document.
   */
  private async getIdbHistory(path: string): Promise<IdbHistorySnapshot> {
    const { hsm, guid, folder, filePath, dbName } = this.resolveIdbTarget(path);

    const db = await this.openDb(dbName);
    try {
      if (!db.objectStoreNames.contains('history')) {
        return {
          path: this.toVaultPath(folder, filePath),
          guid,
          folder: folder.name,
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
        const v = values[i] as {
          origin?: unknown;
          timestamp?: number | null;
          insertions?: { byteLength?: number };
          deletions?: { byteLength?: number };
        };
        return {
          key,
          origin: v.origin ?? null,
          timestamp: v.timestamp ?? null,
          time: v.timestamp ? new Date(v.timestamp).toISOString() : null,
          insertionsBytes: v.insertions?.byteLength ?? 0,
          deletionsBytes: v.deletions?.byteLength ?? 0,
        };
      });

      const persistence = this.hsmInternals(hsm)._persistenceMetadata?.persistence;
      const inMemoryCount = persistence?.opCapture?.entries?.length ?? null;

      return {
        path: this.toVaultPath(folder, filePath),
        guid,
        folder: folder.name,
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
   * Snapshot in-memory and persisted fork state for a document.
   */
  private async getIdbFork(path: string): Promise<IdbForkSnapshot> {
    const { hsm, guid, folder, filePath, hsmDbName } = this.resolveIdbTarget(path);

    const toSnapshot = (f: DebugForkRaw): ForkSnapshot => ({
      base: f.base ?? null,
      baseLength: f.base?.length ?? 0,
      origin: f.origin ?? null,
      created: f.created ?? null,
      createdTime: f.created ? new Date(f.created).toISOString() : null,
      captureMark: f.captureMark ?? null,
      localSnapshotBytes: f.localSnapshot?.byteLength ?? 0,
      remoteSnapshotBytes: f.remoteSnapshot?.byteLength ?? 0,
    });

    const inMemoryFork = this.hsmInternals(hsm)._fork;
    const inMemory: ForkSnapshot | null = inMemoryFork ? toSnapshot(inMemoryFork) : null;

    // Read persisted fork from the shared HSM store. Swallow errors so
    // a broken IDB doesn't hide the in-memory snapshot the caller wants.
    let persistedFork: ForkSnapshot | { error: string } | null = null;
    let persistedMeta: IdbForkSnapshot['persistedMeta'] = null;
    try {
      const db = await this.openDb(hsmDbName);
      try {
        if (db.objectStoreNames.contains('states')) {
          const tx = db.transaction(['states'], 'readonly');
          const state = await this.awaitRequest(
            tx.objectStore('states').get(guid),
            'read persisted state',
          ) as {
            fork?: DebugForkRaw;
            lastStatePath?: string | null;
          } & Record<string, unknown>;
          if (state?.fork) {
            persistedFork = toSnapshot(state.fork);
          }
          if (state) {
            persistedMeta = {
              lastStatePath: state.lastStatePath ?? null,
              persistedAt: typeof state.persistedAt === 'number' ? state.persistedAt : null,
              persistedAtTime: typeof state.persistedAt === 'number' ? new Date(state.persistedAt).toISOString() : null,
              hasForkInPersistedState: !!state.fork,
            };
          }
        }
      } finally {
        db.close();
      }
    } catch (e) {
      persistedFork = { error: e instanceof Error ? e.message : String(e) };
    }

    return {
      path: this.toVaultPath(folder, filePath),
      guid,
      folder: folder.name,
      statePath: this.hsmInternals(hsm)._statePath || 'unknown',
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
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const bridge of this.bridges.values()) {
      bridge.dispose();
    }
    this.bridges.clear();
    this.activeRecordingName = null;
    this.plugin = undefined;

    if (this.debugGlobal()?.__owner === this) {
      delete (this.debugWindow() as unknown as { __relayDebug?: RelayDebugGlobal }).__relayDebug;
    }
  }
}

// =============================================================================
// IDB Utility
// =============================================================================

async function readIdbContent(
  guid: string,
  appId: string,
  timeProvider?: TimeProvider,
): Promise<{ content: string; snapshot: Uint8Array } | null> {
  if (!timeProvider) return null;
  const dbName = `${appId}-relay-doc-${guid}`;
  const tempDoc = new Y.Doc();
  try {
    const persistence = new IndexeddbPersistence(dbName, tempDoc, null, null, timeProvider);
    await persistence.whenSynced;
    const content = tempDoc.getText('contents').toString();
    const snapshot = snapshotFromDoc(tempDoc).snapshot;
    await persistence.destroy();
    return { content, snapshot };
  } catch {
    tempDoc.destroy();
    return null;
  }
}
