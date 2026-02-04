/**
 * E2E Recording Bridge
 *
 * Provides a bridge between the MergeManager and E2E tests running via CDP.
 * Exposes global functions that can be called from the Python E2E test script.
 *
 * Usage in plugin:
 *   import { E2ERecordingBridge } from './merge-hsm/recording/E2ERecordingBridge';
 *
 *   const bridge = new E2ERecordingBridge(mergeManager);
 *   bridge.install(); // Installs global functions
 *
 * Usage from Python E2E test (via CDP eval):
 *   await e2e.eval_js('window.__hsmRecording.startRecording("test-name")')
 *   // ... perform test actions ...
 *   recording = await e2e.eval_js('window.__hsmRecording.stopRecording()')
 */

import type { MergeManager } from '../MergeManager';
import type { MergeHSM } from '../MergeHSM';
import type { MergeEvent, MergeEffect, StatePath } from '../types';
import type { TimeProvider } from '../../TimeProvider';
import { DefaultTimeProvider } from '../../TimeProvider';
import type { HSMRecording, HSMTimelineEntry, RecordingMetadata } from './types';
import {
  serializeEvent,
  serializeEffect,
  createSerializableSnapshot,
  generateRecordingId,
  serializeRecording,
} from './serialization';
import { getHSMBootId, getHSMBootEntries } from '../../debug';

// =============================================================================
// Types
// =============================================================================

/** Entry passed to onEntry streaming callback */
export interface StreamingEntry {
  ns: 'mergeHSM';
  ts: string;
  guid: string;
  path: string;
  event: string;
  from: string;
  to: string;
}

export interface E2ERecordingBridgeConfig {
  /** Time provider (for testing) */
  timeProvider?: TimeProvider;

  /** Maximum entries per document recording */
  maxEntriesPerDoc?: number;

  /** Whether to capture snapshots (more expensive but more complete) */
  captureSnapshots?: boolean;

  /** Output directory for recordings (if using file saving) */
  outputDir?: string;

  /** Streaming callback - called for each entry as it's recorded */
  onEntry?: (entry: StreamingEntry) => void;
}

export interface ActiveDocRecording {
  guid: string;
  path: string;
  startedAt: string;
  initialStatePath: StatePath;
  timeline: HSMTimelineEntry[];
  seqCounter: number;
  unsubscribeEffect: () => void;
  unsubscribeStateChange: () => void;
}

export interface E2ERecordingState {
  recording: boolean;
  name: string | null;
  id: string | null;
  startedAt: string | null;
  documentCount: number;
  totalEntries: number;
}

/**
 * Global interface exposed to E2E tests.
 */
export interface HSMRecordingGlobal {
  /** Start recording all HSM activity */
  startRecording: (name?: string) => E2ERecordingState;

  /** Stop recording and return serialized JSON */
  stopRecording: () => string;

  /** Get current recording state */
  getState: () => E2ERecordingState;

  /** Check if recording is active */
  isRecording: () => boolean;

  /** Get list of active document GUIDs */
  getActiveDocuments: () => string[];

  /** Save recording to IndexedDB (returns key) */
  saveRecording: (recording: string) => Promise<string>;

  /** Load recording from IndexedDB by key */
  loadRecording: (key: string) => Promise<string | null>;

  /** List all saved recording keys */
  listRecordings: () => Promise<string[]>;

  /** Clear all saved recordings */
  clearRecordings: () => Promise<void>;

  /** Get the current boot ID (for disk recording) */
  getBootId: () => string | null;

  /** Get entries from current boot (reads disk file, filters by boot ID) */
  getBootEntries: () => Promise<object[]>;
}

// =============================================================================
// E2ERecordingBridge
// =============================================================================

export class E2ERecordingBridge {
  private readonly manager: MergeManager;
  private readonly timeProvider: TimeProvider;
  private readonly maxEntriesPerDoc: number;
  private readonly captureSnapshots: boolean;
  private readonly outputDir: string;
  private readonly onEntry?: (entry: StreamingEntry) => void;

  // Recording state
  private recording: boolean = false;
  private recordingId: string | null = null;
  private recordingName: string | null = null;
  private startedAt: string | null = null;

  // Per-document recordings
  private docRecordings: Map<string, ActiveDocRecording> = new Map();

  // HSM subscription cleanup
  private managerUnsubscribe: (() => void) | null = null;

  constructor(manager: MergeManager, config: E2ERecordingBridgeConfig = {}) {
    this.manager = manager;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.maxEntriesPerDoc = config.maxEntriesPerDoc ?? 5000;
    this.captureSnapshots = config.captureSnapshots ?? false;
    this.outputDir = config.outputDir ?? '/tmp/hsm-recordings';
    this.onEntry = config.onEntry;

    // If onEntry is provided, automatically stream all HSM events to disk
    // (independent of in-memory recording via startRecording())
    if (this.onEntry) {
      this.startStreaming();
    }
  }

  /**
   * Start streaming HSM events via onEntry callback.
   * Called automatically when onEntry is provided in config.
   */
  private startStreaming(): void {
    // Wrap existing loaded HSMs
    for (const guid of this.manager.getRegisteredGuids()) {
      if (this.manager.isLoaded(guid) && !this.docRecordings.has(guid)) {
        this.startRecordingDocument(guid);
      }
    }

    // Subscribe to new HSMs being loaded
    this.managerUnsubscribe = this.manager.syncStatus.subscribe(() => {
      for (const guid of this.manager.getRegisteredGuids()) {
        if (this.manager.isLoaded(guid) && !this.docRecordings.has(guid)) {
          this.startRecordingDocument(guid);
        }
      }
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Install global functions for E2E test access.
   * Call this during plugin initialization.
   */
  install(): void {
    const global = typeof window !== 'undefined' ? window : globalThis;

    const api: HSMRecordingGlobal = {
      startRecording: (name) => this.startRecording(name),
      stopRecording: () => this.stopRecording(),
      getState: () => this.getState(),
      isRecording: () => this.isRecording(),
      getActiveDocuments: () => this.getActiveDocuments(),
      saveRecording: (recording) => this.saveRecording(recording),
      loadRecording: (key) => this.loadRecording(key),
      listRecordings: () => this.listRecordings(),
      clearRecordings: () => this.clearRecordings(),
      getBootId: () => getHSMBootId(),
      getBootEntries: () => getHSMBootEntries(),
    };

    (global as any).__hsmRecording = api;
  }

  /**
   * Remove global functions.
   */
  uninstall(): void {
    const global = typeof window !== 'undefined' ? window : globalThis;
    delete (global as any).__hsmRecording;
  }

  /**
   * Start recording all HSM activity.
   */
  startRecording(name?: string): E2ERecordingState {
    if (this.recording) {
      throw new Error('Recording already in progress');
    }

    this.recording = true;
    this.recordingId = generateRecordingId();
    this.recordingName = name ?? `E2E Recording ${this.recordingId}`;
    this.startedAt = new Date().toISOString();

    // If streaming is active (onEntry provided), HSMs are already wrapped.
    // Just clear timelines for fresh recording without unwrapping.
    if (this.onEntry) {
      for (const docRec of this.docRecordings.values()) {
        docRec.timeline = [];
        docRec.seqCounter = 0;
        docRec.startedAt = this.startedAt;
      }
    } else {
      // No streaming - set up fresh
      this.docRecordings.clear();

      // Subscribe to existing loaded HSMs
      for (const guid of this.manager.getRegisteredGuids()) {
        if (this.manager.isLoaded(guid)) {
          this.startRecordingDocument(guid);
        }
      }
    }

    // Subscribe to new HSMs being loaded (only if not already subscribed via streaming)
    if (!this.managerUnsubscribe) {
      this.managerUnsubscribe = this.manager.syncStatus.subscribe(() => {
        if (!this.recording) return;

        for (const guid of this.manager.getRegisteredGuids()) {
          if (this.manager.isLoaded(guid) && !this.docRecordings.has(guid)) {
            this.startRecordingDocument(guid);
          }
        }
      });
    }

    return this.getState();
  }

  /**
   * Stop recording and return serialized recordings as JSON.
   * Returns an array of HSMRecording objects, one per document.
   */
  stopRecording(): string {
    if (!this.recording) {
      throw new Error('No recording in progress');
    }

    const recordings: HSMRecording[] = [];

    for (const [guid, docRec] of this.docRecordings.entries()) {
      // Build recording from timeline
      const recording: HSMRecording = {
        version: 1,
        id: `${this.recordingId}-${guid}`,
        name: `${this.recordingName} - ${docRec.path}`,
        startedAt: docRec.startedAt,
        endedAt: new Date().toISOString(),
        document: {
          guid: docRec.guid,
          path: docRec.path,
        },
        initialState: {
          statePath: docRec.initialStatePath,
          snapshot: {
            timestamp: Date.parse(docRec.startedAt),
            state: {
              guid: docRec.guid,
              path: docRec.path,
              statePath: docRec.initialStatePath,
              lca: null,
              disk: null,
              localStateVector: null,
              remoteStateVector: null,
            },
            localDocText: null,
            remoteDocText: null,
          },
        },
        timeline: docRec.timeline,
        metadata: {
          source: 'e2e-test',
          testName: this.recordingName ?? undefined,
          sessionId: this.recordingId ?? undefined,
        } as RecordingMetadata,
      };

      recordings.push(recording);
    }

    // If streaming is active (onEntry provided), keep HSMs wrapped for continued streaming.
    // Only clean up fully when not streaming.
    if (this.onEntry) {
      // Clear timelines but keep HSM wrappers and subscriptions
      for (const docRec of this.docRecordings.values()) {
        docRec.timeline = [];
      }
    } else {
      // Full cleanup - unwrap HSMs and clear everything
      for (const docRec of this.docRecordings.values()) {
        docRec.unsubscribeEffect();
        docRec.unsubscribeStateChange();
      }
      this.managerUnsubscribe?.();
      this.managerUnsubscribe = null;
      this.docRecordings.clear();
    }

    // Reset recording state
    this.recording = false;
    this.recordingId = null;
    this.recordingName = null;
    this.startedAt = null;

    // Return serialized recordings
    return JSON.stringify(recordings.map((r) => JSON.parse(serializeRecording(r))));
  }

  /**
   * Get current recording state.
   */
  getState(): E2ERecordingState {
    let totalEntries = 0;
    for (const docRec of this.docRecordings.values()) {
      totalEntries += docRec.timeline.length;
    }

    return {
      recording: this.recording,
      name: this.recordingName,
      id: this.recordingId,
      startedAt: this.startedAt,
      documentCount: this.docRecordings.size,
      totalEntries,
    };
  }

  /**
   * Check if recording is active.
   */
  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Get list of active document GUIDs being recorded.
   */
  getActiveDocuments(): string[] {
    return Array.from(this.docRecordings.keys());
  }

  // ===========================================================================
  // IndexedDB Storage for Recordings
  // ===========================================================================

  private getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('HSMRecordings', 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings', { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * Save recording JSON to IndexedDB.
   */
  async saveRecording(recordingJson: string): Promise<string> {
    const db = await this.getDB();
    const key = `recording-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readwrite');
      const store = tx.objectStore('recordings');

      const request = store.put({
        key,
        recording: recordingJson,
        savedAt: new Date().toISOString(),
      });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(key);
    });
  }

  /**
   * Load recording JSON from IndexedDB by key.
   */
  async loadRecording(key: string): Promise<string | null> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readonly');
      const store = tx.objectStore('recordings');

      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.recording);
        } else {
          resolve(null);
        }
      };
    });
  }

  /**
   * List all saved recording keys.
   */
  async listRecordings(): Promise<string[]> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readonly');
      const store = tx.objectStore('recordings');

      const request = store.getAllKeys();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result as string[]);
      };
    });
  }

  /**
   * Clear all saved recordings.
   */
  async clearRecordings(): Promise<void> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readwrite');
      const store = tx.objectStore('recordings');

      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Start recording a specific document's HSM.
   */
  private startRecordingDocument(guid: string): void {
    // Access the HSM via the manager (this is internal, we'll need a way to get it)
    const hsm = this.getHSMForGuid(guid);
    if (!hsm) return;

    const path = this.manager.getPath(guid) ?? guid;

    const docRecording: ActiveDocRecording = {
      guid,
      path,
      startedAt: new Date().toISOString(),
      initialStatePath: hsm.state.statePath,
      timeline: [],
      seqCounter: 0,
      unsubscribeEffect: () => {},
      unsubscribeStateChange: () => {},
    };

    // Track pending event for effect capture
    let pendingEvent: {
      event: MergeEvent;
      statePathBefore: StatePath;
      timestamp: number;
      effects: MergeEffect[];
    } | null = null;

    // Subscribe to effects
    docRecording.unsubscribeEffect = hsm.subscribe((effect) => {
      if (pendingEvent) {
        pendingEvent.effects.push(effect);
      }
    });

    // Intercept events by wrapping the send method
    const originalSend = hsm.send.bind(hsm);
    (hsm as any).send = (event: MergeEvent) => {
      // Always capture event data for streaming (onEntry callback)
      // Only add to in-memory timeline if this.recording is true
      const shouldStream = !!this.onEntry;
      const shouldRecord = this.recording;

      if (shouldStream || shouldRecord) {
        pendingEvent = {
          event,
          statePathBefore: hsm.state.statePath,
          timestamp: this.timeProvider.now(),
          effects: [],
        };
      }

      originalSend(event);

      if (pendingEvent) {
        // Finalize timeline entry
        const entry: HSMTimelineEntry = {
          seq: docRecording.seqCounter++,
          timestamp: pendingEvent.timestamp,
          event: serializeEvent(pendingEvent.event),
          statePathBefore: pendingEvent.statePathBefore,
          statePathAfter: hsm.state.statePath,
          effects: pendingEvent.effects.map(serializeEffect),
        };

        // Stream entry if callback provided (always, regardless of recording state)
        if (this.onEntry) {
          this.onEntry({
            ns: 'mergeHSM',
            ts: new Date(pendingEvent.timestamp).toISOString(),
            guid: docRecording.guid,
            path: docRecording.path,
            event: entry.event.type,
            from: entry.statePathBefore,
            to: entry.statePathAfter,
          });
        }

        // Add to in-memory timeline only if recording is active
        if (shouldRecord) {
          docRecording.timeline.push(entry);
          if (docRecording.timeline.length > this.maxEntriesPerDoc) {
            docRecording.timeline.shift();
          }
        }

        pendingEvent = null;
      }
    };

    // Store cleanup for send wrapper
    const cleanup = docRecording.unsubscribeEffect;
    docRecording.unsubscribeEffect = () => {
      cleanup();
      (hsm as any).send = originalSend;
    };

    this.docRecordings.set(guid, docRecording);
  }

  /**
   * Get HSM for a GUID.
   * Note: MergeManager doesn't expose loaded HSMs directly, so we need
   * to work around this. In real integration, we'd add a method to MergeManager.
   */
  private getHSMForGuid(guid: string): MergeHSM | null {
    // Access internal hsms map (for prototype - in real code, add public accessor)
    const hsms = (this.manager as any).hsms as Map<string, MergeHSM>;
    return hsms?.get(guid) ?? null;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.recording) {
      // Stop recording without returning result
      try {
        this.stopRecording();
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Clean up streaming (unwrap all HSMs)
    for (const docRec of this.docRecordings.values()) {
      docRec.unsubscribeEffect();
      docRec.unsubscribeStateChange();
    }
    this.managerUnsubscribe?.();
    this.managerUnsubscribe = null;
    this.docRecordings.clear();

    this.uninstall();
  }
}

// =============================================================================
// Factory Function
// =============================================================================

// Registry of bridges by folder path for multi-folder support
const bridgeRegistry = new Map<string, E2ERecordingBridge>();

// Track active recording state so new bridges auto-join
let activeRecordingName: string | null = null;

/**
 * Create and install E2E recording bridge.
 * Call this in plugin initialization.
 *
 * NOTE: Multiple folders can each have their own bridge.
 * The global __hsmRecording provides aggregate access to all bridges.
 */
export function installE2ERecordingBridge(
  manager: MergeManager,
  config?: E2ERecordingBridgeConfig
): E2ERecordingBridge {
  const bridge = new E2ERecordingBridge(manager, config);

  // Register this bridge (use manager's internal identifier)
  const folderPath = (manager as any).folderPath ?? `manager-${bridgeRegistry.size}`;
  bridgeRegistry.set(folderPath, bridge);

  // Install aggregate API that spans all registered bridges
  installAggregateBridgeAPI();

  // Auto-start recording if a recording is currently active
  if (activeRecordingName !== null) {
    try {
      bridge.startRecording(activeRecordingName);
    } catch {
      // Ignore errors (e.g., already recording)
    }
  }

  return bridge;
}

/**
 * Install global API that aggregates across all folder bridges.
 */
function installAggregateBridgeAPI(): void {
  const global = typeof window !== 'undefined' ? window : globalThis;

  const api: HSMRecordingGlobal = {
    startRecording: (name) => {
      // Track active recording so new bridges auto-join
      activeRecordingName = name ?? 'E2E Recording';

      // Start recording on all bridges
      const results: E2ERecordingState[] = [];
      for (const bridge of bridgeRegistry.values()) {
        try {
          results.push(bridge.startRecording(name));
        } catch (e) {
          // Bridge might already be recording
        }
      }
      // Return aggregate state
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
      // Clear active recording tracking
      activeRecordingName = null;

      // Stop recording on all bridges and combine results
      const recordings: string[] = [];
      for (const bridge of bridgeRegistry.values()) {
        try {
          recordings.push(bridge.stopRecording());
        } catch (e) {
          // Bridge might not be recording
        }
      }
      // Combine recordings (each is a JSON array)
      const combined = recordings.flatMap(r => {
        try { return JSON.parse(r); } catch { return []; }
      });
      return JSON.stringify(combined, null, 2);
    },
    getState: () => {
      // Aggregate state across all bridges
      let totalDocs = 0;
      let totalEntries = 0;
      let recording = false;
      let name: string | null = null;
      let id: string | null = null;
      let startedAt: string | null = null;

      for (const bridge of bridgeRegistry.values()) {
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
      return Array.from(bridgeRegistry.values()).some(b => b.isRecording());
    },
    getActiveDocuments: () => {
      // Combine active documents from all bridges
      const docs: string[] = [];
      for (const bridge of bridgeRegistry.values()) {
        docs.push(...bridge.getActiveDocuments());
      }
      return docs;
    },
    saveRecording: (recording) => {
      // Save to first bridge (they all share localStorage)
      const firstBridge = bridgeRegistry.values().next().value;
      return firstBridge?.saveRecording(recording) ?? '';
    },
    loadRecording: (key) => {
      const firstBridge = bridgeRegistry.values().next().value;
      return firstBridge?.loadRecording(key) ?? null;
    },
    listRecordings: () => {
      const firstBridge = bridgeRegistry.values().next().value;
      return firstBridge?.listRecordings() ?? [];
    },
    clearRecordings: async () => {
      const firstBridge = bridgeRegistry.values().next().value;
      await firstBridge?.clearRecordings();
    },
    getBootId: () => getHSMBootId(),
    getBootEntries: () => getHSMBootEntries(),
  };

  (global as any).__hsmRecording = api;
}
