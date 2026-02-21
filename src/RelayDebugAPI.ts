/**
 * RelayDebugAPI — Plugin-level debug surface exposed as `window.__relayDebug`.
 *
 * Aggregates per-folder recording bridges and provides CDP-accessible
 * utilities for E2E tests, live debugging, and diagnostics.
 *
 * Lifecycle: created in plugin onload(), destroyed in onunload().
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from './storage/y-indexeddb';
import type { E2ERecordingBridge, E2ERecordingState } from './merge-hsm/recording';
import { getHSMBootId, getHSMBootEntries, getRecentEntries } from './debug';

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
}

// =============================================================================
// RelayDebugAPI
// =============================================================================

export class RelayDebugAPI {
  private bridges = new Map<string, E2ERecordingBridge>();
  private activeRecordingName: string | null = null;

  constructor() {
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
    };

    (g as any).__relayDebug = api;
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
