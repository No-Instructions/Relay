/**
 * MergeHSM - Hierarchical State Machine for Document Synchronization
 *
 * Built on XState v5 as specified in the design document.
 *
 * Manages the sync between disk, local CRDT (Yjs), and remote CRDT.
 * Pure state machine: events in → state transitions → effects out.
 *
 * Architecture:
 * - Two-YDoc architecture: localDoc (persisted) + remoteDoc (ephemeral)
 * - In active mode: editor ↔ localDoc ↔ remoteDoc ↔ server
 * - In idle mode: lightweight, no YDocs in memory
 */

import { setup, createActor, assign, type AnyActorRef } from 'xstate';
import * as Y from 'yjs';
import { diff3Merge } from 'node-diff3';
import { diff_match_patch } from 'diff-match-patch';
import type {
  MergeState,
  MergeEvent,
  MergeEffect,
  StatePath,
  LCAState,
  MergeMetadata,
  PositionedChange,
  MergeHSMConfig,
  MergeResult,
  SyncStatus,
  SyncStatusType,
  PersistedMergeState,
} from './types';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import type { TestableHSM } from './testing/createTestHSM';

// =============================================================================
// Simple Observable for HSM
// =============================================================================

type Subscriber<T> = (value: T) => void;
type Unsubscriber = () => void;

/**
 * Simple Observable interface matching the spec.
 */
export interface IObservable<T> {
  subscribe(run: Subscriber<T>): Unsubscriber;
}

/**
 * Simple Observable implementation for the HSM.
 * Does not use PostOffice - notifications are synchronous.
 */
class SimpleObservable<T> implements IObservable<T> {
  private listeners: Set<Subscriber<T>> = new Set();

  subscribe(run: Subscriber<T>): Unsubscriber {
    this.listeners.add(run);
    return () => {
      this.listeners.delete(run);
    };
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

// =============================================================================
// XState Machine Context
// =============================================================================

interface MergeContext {
  guid: string;
  path: string;
  lca: LCAState | null;
  disk: MergeMetadata | null;
  localStateVector: Uint8Array | null;
  remoteStateVector: Uint8Array | null;
  error: Error | undefined;
  deferredConflict: { diskHash: string; localHash: string } | undefined;
}

// =============================================================================
// XState Machine Definition
// =============================================================================

type MergeEvents = MergeEvent;

const mergeMachine = setup({
  types: {
    context: {} as MergeContext,
    events: {} as MergeEvents,
  },
  actions: {
    setGuidAndPath: assign({
      guid: ({ event }) => {
        if (event.type === 'LOAD') return event.guid;
        return undefined as never;
      },
      path: ({ event }) => {
        if (event.type === 'LOAD') return event.path;
        return undefined as never;
      },
    }),
    setLCA: assign({
      lca: ({ event }) => {
        if (event.type === 'PERSISTENCE_LOADED') return event.lca;
        return undefined as never;
      },
    }),
    setLocalStateVector: assign({
      localStateVector: ({ event }) => {
        if (event.type === 'PERSISTENCE_LOADED' && event.updates.length > 0) {
          return Y.encodeStateVectorFromUpdate(event.updates);
        }
        return null;
      },
    }),
    setRemoteStateVector: assign({
      remoteStateVector: ({ event }) => {
        if (event.type === 'REMOTE_UPDATE') {
          return Y.encodeStateVectorFromUpdate(event.update);
        }
        return undefined as never;
      },
    }),
    setDiskMeta: assign({
      disk: ({ event }) => {
        if (event.type === 'DISK_CHANGED') {
          return { hash: event.hash, mtime: event.mtime };
        }
        return undefined as never;
      },
    }),
    setError: assign({
      error: ({ event }) => {
        if (event.type === 'ERROR') return event.error;
        return undefined as never;
      },
    }),
    updateLCAFromMerge: assign({
      lca: ({ event }) => {
        if (event.type === 'MERGE_SUCCESS') return event.newLCA;
        return undefined as never;
      },
    }),
    setDeferredConflict: assign({
      deferredConflict: ({ context }) => ({
        diskHash: context.disk?.hash ?? '',
        localHash: '', // Will be computed by wrapper
      }),
    }),
    clearDeferredConflict: assign({
      deferredConflict: () => undefined,
    }),
    updateLCAMtime: assign({
      lca: ({ context, event }) => {
        if (event.type === 'SAVE_COMPLETE' && context.lca) {
          return {
            ...context.lca,
            meta: {
              ...context.lca.meta,
              mtime: event.mtime,
            },
          };
        }
        return context.lca;
      },
    }),
  },
  guards: {
    isDiverged: ({ context }): boolean => {
      // Check if we have divergence from LCA
      if (!context.lca) return false;
      const lcaSV = context.lca.stateVector;
      const localSV = context.localStateVector;
      const remoteSV = context.remoteStateVector;
      const diskChanged = !!(context.disk && context.lca.meta.hash !== context.disk.hash);
      const localChanged = !!(localSV && !stateVectorsEqual(lcaSV, localSV));
      const remoteChanged = !!(remoteSV && !stateVectorsEqual(lcaSV, remoteSV));

      return (localChanged && diskChanged) || (localChanged && remoteChanged) || (diskChanged && remoteChanged);
    },
  },
}).createMachine({
  id: 'mergeHSM',
  initial: 'unloaded',
  context: {
    guid: '',
    path: '',
    lca: null,
    disk: null,
    localStateVector: null,
    remoteStateVector: null,
    error: undefined,
    deferredConflict: undefined,
  },
  states: {
    unloaded: {
      on: {
        LOAD: {
          target: 'loading.loadingPersistence',
          actions: ['setGuidAndPath'],
        },
      },
    },
    loading: {
      initial: 'loadingPersistence',
      states: {
        loadingPersistence: {
          on: {
            PERSISTENCE_LOADED: {
              target: 'loadingLCA',
              actions: ['setLCA', 'setLocalStateVector'],
            },
          },
        },
        loadingLCA: {
          // This is a transient state - wrapper handles auto-transition
        },
      },
      on: {
        ACQUIRE_LOCK: {
          target: 'active.entering',
        },
      },
    },
    idle: {
      initial: 'clean',
      states: {
        clean: {},
        localAhead: {},
        remoteAhead: {},
        diskAhead: {},
        diverged: {},
        error: {},
      },
      on: {
        LOAD: {
          target: 'loading.loadingPersistence',
          actions: ['setGuidAndPath'],
        },
        UNLOAD: {
          target: 'unloading',
        },
        ACQUIRE_LOCK: [
          {
            target: 'active.conflict.blocked',
            guard: ({ context }) => {
              // Going to conflict.blocked if coming from diverged
              return false; // Wrapper handles this logic
            },
          },
          {
            target: 'active.entering',
          },
        ],
        REMOTE_UPDATE: {
          actions: ['setRemoteStateVector'],
          // Wrapper handles state determination and auto-merge
        },
        DISK_CHANGED: {
          actions: ['setDiskMeta'],
          // Wrapper handles state determination and auto-merge
        },
        ERROR: {
          target: '.error',
          actions: ['setError'],
        },
      },
    },
    active: {
      initial: 'entering',
      states: {
        entering: {
          on: {
            YDOCS_READY: {
              target: 'tracking',
            },
          },
        },
        tracking: {
          on: {
            DISK_CHANGED: {
              target: 'merging',
              actions: ['setDiskMeta'],
            },
            CM6_CHANGE: {
              // Handled by wrapper
            },
            REMOTE_UPDATE: {
              actions: ['setRemoteStateVector'],
              // Wrapper handles merge
            },
            SAVE_COMPLETE: {
              actions: ['updateLCAMtime'],
            },
          },
        },
        merging: {
          on: {
            MERGE_SUCCESS: {
              target: 'tracking',
              actions: ['updateLCAFromMerge'],
            },
            MERGE_CONFLICT: {
              target: 'conflict.bannerShown',
            },
          },
        },
        conflict: {
          initial: 'blocked',
          states: {
            blocked: {
              // Transient - immediately goes to bannerShown
            },
            bannerShown: {
              on: {
                OPEN_DIFF_VIEW: {
                  target: 'resolving',
                },
                DISMISS_CONFLICT: {
                  target: '#mergeHSM.active.tracking',
                  actions: ['setDeferredConflict'],
                },
              },
            },
            resolving: {
              on: {
                RESOLVE_ACCEPT_DISK: {
                  target: '#mergeHSM.active.tracking',
                  actions: ['clearDeferredConflict'],
                },
                RESOLVE_ACCEPT_LOCAL: {
                  target: '#mergeHSM.active.tracking',
                  actions: ['clearDeferredConflict'],
                },
                RESOLVE_ACCEPT_MERGED: {
                  target: '#mergeHSM.active.tracking',
                  actions: ['clearDeferredConflict'],
                },
                CANCEL: {
                  target: 'bannerShown',
                },
              },
            },
          },
        },
      },
      on: {
        RELEASE_LOCK: {
          target: 'unloading',
        },
        UNLOAD: {
          target: 'unloading',
        },
        CONNECTED: {},
        DISCONNECTED: {},
        PROVIDER_SYNCED: {},
      },
    },
    unloading: {
      always: {
        target: 'idle.clean',
      },
    },
  },
});

// =============================================================================
// Extended Config for Testing
// =============================================================================

export interface TestMergeHSMConfig extends Omit<MergeHSMConfig, 'remoteDoc'> {
  /** Remote YDoc (optional for testing - will be created if not provided) */
  remoteDoc?: Y.Doc;

  /** Initial state path to bootstrap to */
  initialState?: StatePath;

  /** Initial content for localDoc (requires active state) */
  localDocContent?: string;

  /** Initial LCA state */
  lca?: LCAState;

  /** Initial disk metadata */
  disk?: MergeMetadata;

  /** Initial disk contents (for idle mode testing) */
  diskContents?: string;
}

// =============================================================================
// MergeHSM Class (Wrapper around XState Actor)
// =============================================================================

export class MergeHSM implements TestableHSM {
  // XState actor
  private actor: AnyActorRef;

  // Cached state path (computed from XState state value)
  private _statePath: StatePath = 'unloaded';

  // Extended state not in XState context
  private _guid: string;
  private _path: string;
  private _lca: LCAState | null = null;
  private _disk: MergeMetadata | null = null;
  private _localStateVector: Uint8Array | null = null;
  private _remoteStateVector: Uint8Array | null = null;
  private _error: Error | undefined;
  private _deferredConflict: { diskHash: string; localHash: string } | undefined;

  // YDocs (only populated in active mode)
  private localDoc: Y.Doc | null = null;
  private remoteDoc: Y.Doc | null = null;

  // Pending disk contents for merge
  private pendingDiskContents: string | null = null;

  // Conflict data
  private conflictData: { base: string; local: string; remote: string } | null = null;

  // Track previous sync status for change detection
  private lastSyncStatus: SyncStatusType = 'synced';

  // Pending updates for idle mode auto-merge (received via REMOTE_UPDATE)
  private pendingIdleUpdates: Uint8Array | null = null;

  // Persisted updates loaded from IndexedDB (received via PERSISTENCE_LOADED)
  // These are applied to localDoc when transitioning to active mode
  private persistedUpdates: Uint8Array | null = null;

  // Last known editor text (for drift detection)
  private lastKnownEditorText: string | null = null;

  // Observables (per spec)
  private readonly _effects = new SimpleObservable<MergeEffect>();
  private readonly _stateChanges = new SimpleObservable<MergeState>();

  // Legacy listeners (for backward compatibility with test harness)
  private stateChangeListeners: Array<
    (from: StatePath, to: StatePath, event: MergeEvent) => void
  > = [];

  // Configuration
  private timeProvider: TimeProvider;
  private hashFn: (contents: string) => Promise<string>;
  private vaultId: string;

  // Remote doc is passed in and managed externally
  private externalRemoteDoc: Y.Doc;

  // Lock requested during loading (deferred until PERSISTENCE_LOADED)
  private pendingLockAcquisition = false;

  constructor(config: MergeHSMConfig) {
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn ?? defaultHashFn;
    this._guid = config.guid;
    this._path = config.path;
    this.vaultId = config.vaultId;
    this.externalRemoteDoc = config.remoteDoc;

    // Create and start the XState actor
    this.actor = createActor(mergeMachine, {
      input: {
        guid: config.guid,
        path: config.path,
      },
    });

    // Subscribe to state changes
    this.actor.subscribe((snapshot) => {
      const newStatePath = this.stateValueToPath(snapshot.value);
      if (newStatePath !== this._statePath) {
        const oldPath = this._statePath;
        this._statePath = newStatePath;
        // Context is synced separately
      }
    });

    this.actor.start();
  }

  /**
   * Create a MergeHSM instance for testing with optional initial state.
   * This bypasses normal state transitions for test setup.
   */
  static forTesting(config: TestMergeHSMConfig): MergeHSM {
    // Create remoteDoc if not provided (for testing convenience)
    const remoteDoc = config.remoteDoc ?? new Y.Doc();

    const hsm = new MergeHSM({
      guid: config.guid,
      path: config.path,
      vaultId: config.vaultId,
      remoteDoc,
      timeProvider: config.timeProvider,
      hashFn: config.hashFn,
    });

    // Stop the default actor and set up test state
    hsm.actor.stop();

    // Set initial state and data
    if (config.initialState) {
      hsm._statePath = config.initialState;
    }
    if (config.lca) {
      hsm._lca = config.lca;
    }
    if (config.disk) {
      hsm._disk = config.disk;
    }

    // Set disk contents for idle mode testing
    if (config.diskContents !== undefined) {
      hsm.pendingDiskContents = config.diskContents;
    }

    // If starting in active state, create YDocs
    if (config.initialState?.startsWith('active.')) {
      hsm.createYDocs();

      if (config.localDocContent !== undefined) {
        hsm.initializeLocalDoc(config.localDocContent);
      }
    }

    return hsm;
  }

  // ===========================================================================
  // State Value to Path Conversion
  // ===========================================================================

  private stateValueToPath(value: unknown): StatePath {
    if (typeof value === 'string') {
      return value as StatePath;
    }
    if (typeof value === 'object' && value !== null) {
      // Nested state - build path
      const entries = Object.entries(value);
      if (entries.length === 1) {
        const [parent, child] = entries[0];
        if (typeof child === 'string') {
          return `${parent}.${child}` as StatePath;
        }
        if (typeof child === 'object' && child !== null) {
          const childPath = this.stateValueToPath(child);
          return `${parent}.${childPath}` as StatePath;
        }
      }
    }
    return 'unloaded';
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  get path(): string {
    return this._path;
  }

  get guid(): string {
    return this._guid;
  }

  get state(): MergeState {
    return {
      guid: this._guid,
      path: this._path,
      lca: this._lca,
      disk: this._disk,
      localStateVector: this._localStateVector,
      remoteStateVector: this._remoteStateVector,
      statePath: this._statePath,
      error: this._error,
      deferredConflict: this._deferredConflict,
    };
  }

  send(event: MergeEvent): void {
    const fromState = this._statePath;
    this.handleEvent(event);
    const toState = this._statePath;

    // Always notify state change, even if state path unchanged.
    // This ensures subscribers (like MergeManager.syncStatus) are updated
    // when properties like diskMtime change without a state transition.
    // Subscribers should be idempotent.
    this.notifyStateChange(fromState, toState, event);
  }

  matches(statePath: string): boolean {
    return (
      this._statePath === statePath ||
      this._statePath.startsWith(statePath + '.')
    );
  }

  /**
   * Check if the HSM is in active mode (editor open, lock acquired).
   */
  isActive(): boolean {
    return this._statePath.startsWith('active.');
  }

  /**
   * Check if the HSM is in idle mode (no editor, lightweight state).
   */
  isIdle(): boolean {
    return this._statePath.startsWith('idle.');
  }

  getLocalDoc(): Y.Doc | null {
    return this.localDoc;
  }

  getRemoteDoc(): Y.Doc | null {
    return this.remoteDoc;
  }

  /**
   * Get the current sync status for this document.
   */
  getSyncStatus(): SyncStatus {
    return {
      guid: this._guid,
      path: this._path,
      status: this.computeSyncStatusType(),
      diskMtime: this._disk?.mtime ?? 0,
      localStateVector: this._localStateVector ?? new Uint8Array([0]),
      remoteStateVector: this._remoteStateVector ?? new Uint8Array([0]),
    };
  }

  /**
   * Check for drift between editor and localDoc, correcting if needed.
   * Returns true if drift was detected and corrected.
   */
  checkAndCorrectDrift(): boolean {
    if (this._statePath !== 'active.tracking') {
      return false;
    }

    if (!this.localDoc || this.lastKnownEditorText === null) {
      return false;
    }

    const editorText = this.lastKnownEditorText;
    const yjsText = this.localDoc.getText('content').toString();

    if (editorText === yjsText) {
      return false; // No drift
    }

    // Drift detected - localDoc (Yjs) wins
    const changes = this.computeDiffChanges(editorText, yjsText);

    if (changes.length > 0) {
      this.emitEffect({
        type: 'DISPATCH_CM6',
        changes,
      });
    }

    // Update our tracking to reflect the corrected state
    this.lastKnownEditorText = yjsText;

    return true;
  }

  /**
   * Observable of effects emitted by the HSM (per spec).
   */
  get effects(): IObservable<MergeEffect> {
    return this._effects;
  }

  /**
   * Observable of state changes (per spec).
   */
  get stateChanges(): IObservable<MergeState> {
    return this._stateChanges;
  }

  /**
   * Subscribe to effects (convenience method, equivalent to effects.subscribe).
   */
  subscribe(listener: (effect: MergeEffect) => void): () => void {
    return this._effects.subscribe(listener);
  }

  /**
   * Subscribe to state changes with detailed transition info (for test harness).
   */
  onStateChange(
    listener: (from: StatePath, to: StatePath, event: MergeEvent) => void
  ): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      const index = this.stateChangeListeners.indexOf(listener);
      if (index >= 0) {
        this.stateChangeListeners.splice(index, 1);
      }
    };
  }

  // ===========================================================================
  // Event Handler (Uses XState for state transitions)
  // ===========================================================================

  private handleEvent(event: MergeEvent): void {
    switch (event.type) {
      // External Events
      case 'LOAD':
        this.handleLoad(event);
        break;

      case 'UNLOAD':
        this.handleUnload();
        break;

      case 'ACQUIRE_LOCK':
        this.handleAcquireLock();
        break;

      case 'RELEASE_LOCK':
        this.handleReleaseLock();
        break;

      case 'DISK_CHANGED':
        this.handleDiskChanged(event);
        break;

      case 'REMOTE_UPDATE':
        this.handleRemoteUpdate(event);
        break;

      case 'SAVE_COMPLETE':
        this.handleSaveComplete(event);
        break;

      case 'CM6_CHANGE':
        this.handleCM6Change(event);
        break;

      case 'PROVIDER_SYNCED':
        this.handleProviderSynced();
        break;

      case 'CONNECTED':
        this.handleConnected();
        break;

      case 'DISCONNECTED':
        this.handleDisconnected();
        break;

      // User Events
      case 'RESOLVE_ACCEPT_DISK':
      case 'RESOLVE_ACCEPT_LOCAL':
      case 'RESOLVE_ACCEPT_MERGED':
        this.handleResolve(event);
        break;

      case 'DISMISS_CONFLICT':
        this.handleDismissConflict();
        break;

      case 'OPEN_DIFF_VIEW':
        this.handleOpenDiffView();
        break;

      case 'CANCEL':
        this.handleCancel();
        break;

      // Internal Events
      case 'PERSISTENCE_LOADED':
        this.handlePersistenceLoaded(event);
        break;

      case 'YDOCS_READY':
        this.handleYDocsReady();
        break;

      case 'MERGE_SUCCESS':
        this.handleMergeSuccess(event);
        break;

      case 'MERGE_CONFLICT':
        this.handleMergeConflict(event);
        break;

      case 'REMOTE_DOC_UPDATED':
        this.handleRemoteDocUpdated();
        break;

      case 'ERROR':
        this.handleError(event);
        break;
    }
  }

  // ===========================================================================
  // Loading & Unloading
  // ===========================================================================

  private handleLoad(event: { guid: string; path: string }): void {
    this._guid = event.guid;
    this._path = event.path;
    this.transitionTo('loading.loadingPersistence');
  }

  private handlePersistenceLoaded(event: {
    updates: Uint8Array;
    lca: LCAState | null;
  }): void {
    this._lca = event.lca;

    // Store persisted updates for applying when entering active mode
    // Also compute state vector for idle mode comparisons
    if (event.updates.length > 0) {
      this.persistedUpdates = event.updates;
      this._localStateVector = Y.encodeStateVectorFromUpdate(event.updates);
    }

    // Transition through loadingLCA briefly
    this.transitionTo('loading.loadingLCA');

    // Check if lock was requested during loading (per spec: loadingLCA checks for lock)
    if (this.pendingLockAcquisition) {
      this.pendingLockAcquisition = false;
      this.createYDocs();
      // Per spec: auto-transition based on LOCAL state, don't wait for network
      this.transitionTo('active.entering');
      this.transitionTo('active.tracking');
      return;
    }

    // Auto-transition to appropriate idle state based on current knowledge
    this.determineAndTransitionToIdleState();
  }

  private determineAndTransitionToIdleState(): void {
    const lca = this._lca;
    const disk = this._disk;
    const localSV = this._localStateVector;
    const remoteSV = this._remoteStateVector;

    // No LCA means we haven't established a sync point yet
    if (!lca) {
      if (localSV && localSV.length > 1) {
        this.transitionTo('idle.localAhead');
        return;
      }
      this.transitionTo('idle.clean');
      return;
    }

    // Check for divergence scenarios
    const localChanged = this.hasLocalChangedSinceLCA();
    const diskChanged = this.hasDiskChangedSinceLCA();
    const remoteChanged = this.hasRemoteChangedSinceLCA();

    if (localChanged && diskChanged) {
      this.transitionTo('idle.diverged');
    } else if (localChanged && remoteChanged) {
      this.transitionTo('idle.diverged');
    } else if (diskChanged && remoteChanged) {
      this.transitionTo('idle.diverged');
    } else if (localChanged) {
      this.transitionTo('idle.localAhead');
    } else if (diskChanged) {
      this.transitionTo('idle.diskAhead');
    } else if (remoteChanged) {
      this.transitionTo('idle.remoteAhead');
    } else {
      this.transitionTo('idle.clean');
    }
  }

  private hasLocalChangedSinceLCA(): boolean {
    if (!this._lca) return false;
    const lcaSV = this._lca.stateVector;
    const localSV = this._localStateVector;

    if (!localSV) return false;

    return !stateVectorsEqual(lcaSV, localSV);
  }

  private hasDiskChangedSinceLCA(): boolean {
    if (!this._lca || !this._disk) return false;
    return this._lca.meta.hash !== this._disk.hash;
  }

  private hasRemoteChangedSinceLCA(): boolean {
    if (!this._lca) return false;
    const lcaSV = this._lca.stateVector;
    const remoteSV = this._remoteStateVector;

    if (!remoteSV) return false;

    return !stateVectorsEqual(lcaSV, remoteSV);
  }

  // ===========================================================================
  // Idle Mode Auto-Merge
  // ===========================================================================

  private attemptIdleAutoMerge(): void {
    const state = this._statePath;
    const handleError = (err: unknown) => {
      this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
    };

    if (state === 'idle.remoteAhead') {
      if (!this.hasDiskChangedSinceLCA()) {
        this.performIdleRemoteAutoMerge(handleError);
      }
    } else if (state === 'idle.diskAhead') {
      if (!this.hasRemoteChangedSinceLCA()) {
        this.performIdleDiskAutoMerge(handleError);
      }
    } else if (state === 'idle.diverged') {
      this.performIdleThreeWayMerge().catch(handleError);
    }
  }

  private performIdleRemoteAutoMerge(handleError: (err: unknown) => void): void {
    if (!this.pendingIdleUpdates || !this._lca) return;

    const tempDoc = new Y.Doc();
    try {
      Y.applyUpdate(tempDoc, this.pendingIdleUpdates);

      const mergedContent = tempDoc.getText('content').toString();
      const stateVector = Y.encodeStateVector(tempDoc);

      // Emit effect synchronously
      this.emitEffect({
        type: 'WRITE_DISK',
        path: this._path,
        contents: mergedContent,
      });

      // Clear pending and transition synchronously
      this.pendingIdleUpdates = null;
      this.transitionTo('idle.clean');

      // Update LCA asynchronously (fire-and-forget)
      this.hashFn(mergedContent).then((hash) => {
        this._lca = {
          contents: mergedContent,
          meta: {
            hash,
            mtime: this.timeProvider.now(),
          },
          stateVector,
        };
        this.emitPersistState();
      }).catch(handleError);
    } finally {
      tempDoc.destroy();
    }
  }

  private performIdleDiskAutoMerge(handleError: (err: unknown) => void): void {
    if (!this.pendingDiskContents || !this._lca) return;

    const tempDoc = new Y.Doc();
    try {
      tempDoc.getText('content').insert(0, this.pendingDiskContents);

      const update = Y.encodeStateAsUpdate(tempDoc);
      const stateVector = Y.encodeStateVector(tempDoc);
      const diskContent = this.pendingDiskContents;
      const diskHash = this._disk?.hash;
      const diskMtime = this._disk?.mtime ?? this.timeProvider.now();

      // Emit effect synchronously
      this.emitEffect({ type: 'SYNC_TO_REMOTE', update });

      // Clear pending and transition synchronously
      this.pendingDiskContents = null;
      this.transitionTo('idle.clean');

      // Update LCA asynchronously (fire-and-forget)
      // Use disk hash if available, otherwise compute
      const hashPromise = diskHash
        ? Promise.resolve(diskHash)
        : this.hashFn(diskContent);

      hashPromise.then((hash) => {
        this._lca = {
          contents: diskContent,
          meta: {
            hash,
            mtime: diskMtime,
          },
          stateVector,
        };
        this.emitPersistState();
      }).catch(handleError);
    } finally {
      tempDoc.destroy();
    }
  }

  private async performIdleThreeWayMerge(): Promise<void> {
    if (!this._lca) return;

    const lcaContent = this._lca.contents;

    let remoteContent = lcaContent;
    if (this.pendingIdleUpdates) {
      const tempDoc = new Y.Doc();
      try {
        Y.applyUpdate(tempDoc, this.pendingIdleUpdates);
        remoteContent = tempDoc.getText('content').toString();
      } finally {
        tempDoc.destroy();
      }
    }

    const diskContent = this.pendingDiskContents ?? lcaContent;

    const mergeResult = performThreeWayMerge(lcaContent, diskContent, remoteContent);

    if (mergeResult.success) {
      this.emitEffect({
        type: 'WRITE_DISK',
        path: this._path,
        contents: mergeResult.merged,
      });

      const tempDoc = new Y.Doc();
      try {
        tempDoc.getText('content').insert(0, mergeResult.merged);

        this._lca = {
          contents: mergeResult.merged,
          meta: {
            // Merged content is new, compute hash
            hash: await this.hashFn(mergeResult.merged),
            mtime: this.timeProvider.now(),
          },
          stateVector: Y.encodeStateVector(tempDoc),
        };
      } finally {
        tempDoc.destroy();
      }

      const syncDoc = new Y.Doc();
      try {
        syncDoc.getText('content').insert(0, mergeResult.merged);
        const update = Y.encodeStateAsUpdate(syncDoc);
        this.emitEffect({ type: 'SYNC_TO_REMOTE', update });
      } finally {
        syncDoc.destroy();
      }

      this.pendingIdleUpdates = null;
      this.pendingDiskContents = null;

      this.transitionTo('idle.clean');
      this.emitPersistState();
    }
  }

  private handleUnload(): void {
    this.transitionTo('unloading');
    this.cleanupYDocs();
    this.transitionTo('unloaded');
  }

  // ===========================================================================
  // Lock Management (Idle ↔ Active)
  // ===========================================================================

  private handleAcquireLock(): void {
    // If in loading state, defer lock acquisition until PERSISTENCE_LOADED
    if (this._statePath.startsWith('loading.')) {
      this.pendingLockAcquisition = true;
      return;
    }

    if (this._statePath.startsWith('idle.')) {
      this.createYDocs();

      if (this._statePath === 'idle.diverged') {
        this.transitionTo('active.conflict.blocked');
        this.transitionTo('active.conflict.bannerShown');
      } else {
        // Per spec: "This transition is based entirely on LOCAL state.
        // Provider sync happens asynchronously and does not block.
        // The editor must be usable immediately, even when offline."
        //
        // We transition through active.entering briefly, then immediately
        // to active.tracking. No waiting for YDOCS_READY or network.
        this.transitionTo('active.entering');
        this.transitionTo('active.tracking');
      }
    }
  }

  private handleYDocsReady(): void {
    if (this._statePath === 'active.entering') {
      this.transitionTo('active.tracking');
    }
  }

  private handleReleaseLock(): void {
    if (this._statePath.startsWith('active.')) {
      // Determine target idle state based on current state before cleanup
      const wasInConflict = this._statePath.includes('conflict');

      this.transitionTo('unloading');
      this.cleanupYDocs();

      // Transition to appropriate idle state
      if (wasInConflict) {
        this.transitionTo('idle.diverged');
      } else {
        this.determineAndTransitionToIdleState();
      }
    }
  }

  // ===========================================================================
  // YDoc Management
  // ===========================================================================

  private createYDocs(): void {
    this.localDoc = new Y.Doc();
    // remoteDoc is passed in externally, just reference it in active mode
    this.remoteDoc = this.externalRemoteDoc;

    // Apply persisted updates from IndexedDB (loaded via PERSISTENCE_LOADED)
    // This ensures localDoc has all the content from previous sessions
    if (this.persistedUpdates && this.persistedUpdates.length > 0) {
      Y.applyUpdate(this.localDoc, this.persistedUpdates);
    }

    // Also apply any updates received during idle mode (via REMOTE_UPDATE)
    // These were accumulated while no editor was open
    if (this.pendingIdleUpdates && this.pendingIdleUpdates.length > 0) {
      Y.applyUpdate(this.localDoc, this.pendingIdleUpdates);
      this.pendingIdleUpdates = null; // Clear after applying
    }

    // Update state vector to reflect what's in localDoc
    if (this.localDoc) {
      this._localStateVector = Y.encodeStateVector(this.localDoc);
    }
  }

  private cleanupYDocs(): void {
    if (this.localDoc) {
      this.localDoc.destroy();
      this.localDoc = null;
    }
    // Do NOT destroy remoteDoc - it's managed externally
    // Just clear our reference to it
    this.remoteDoc = null;
  }

  initializeLocalDoc(content: string): void {
    if (!this.localDoc || !this.remoteDoc) return;

    this.localDoc.getText('content').insert(0, content);
    Y.applyUpdate(this.remoteDoc, Y.encodeStateAsUpdate(this.localDoc));
  }

  // ===========================================================================
  // Active Mode: Editor Integration
  // ===========================================================================

  private handleCM6Change(event: {
    changes: PositionedChange[];
    docText: string;
    isFromYjs: boolean;
  }): void {
    if (this._statePath !== 'active.tracking') return;

    this.lastKnownEditorText = event.docText;

    if (event.isFromYjs) return;

    if (this.localDoc) {
      const ytext = this.localDoc.getText('content');
      this.localDoc.transact(() => {
        for (const change of event.changes) {
          if (change.to > change.from) {
            ytext.delete(change.from, change.to - change.from);
          }
          if (change.insert) {
            ytext.insert(change.from, change.insert);
          }
        }
      }, this);
    }

    this.syncLocalToRemote();
  }

  private syncLocalToRemote(): void {
    if (!this.localDoc || !this.remoteDoc) return;

    const update = Y.encodeStateAsUpdate(
      this.localDoc,
      Y.encodeStateVector(this.remoteDoc)
    );

    if (update.length > 0) {
      Y.applyUpdate(this.remoteDoc, update, 'local');
      this.emitEffect({ type: 'SYNC_TO_REMOTE', update });
    }
  }

  // ===========================================================================
  // Active Mode: Remote Updates
  // ===========================================================================

  private handleRemoteUpdate(event: { update: Uint8Array }): void {
    if (this.remoteDoc) {
      Y.applyUpdate(this.remoteDoc, event.update, 'remote');
    }

    this._remoteStateVector = Y.encodeStateVectorFromUpdate(event.update);

    if (this._statePath === 'active.tracking') {
      this.mergeRemoteToLocal();
    } else if (this._statePath.startsWith('idle.')) {
      if (this.pendingIdleUpdates) {
        this.pendingIdleUpdates = Y.mergeUpdates([this.pendingIdleUpdates, event.update]);
      } else {
        this.pendingIdleUpdates = event.update;
      }

      // Emit PERSIST_UPDATES effect for IndexedDB storage (per spec)
      this.emitEffect({
        type: 'PERSIST_UPDATES',
        dbName: this.vaultId,
        update: this.pendingIdleUpdates,
      });

      if (this.hasDiskChangedSinceLCA()) {
        this.transitionTo('idle.diverged');
      } else {
        this.transitionTo('idle.remoteAhead');
      }
      this.attemptIdleAutoMerge();
    }
  }

  private handleRemoteDocUpdated(): void {
    if (this._statePath === 'active.tracking') {
      this.mergeRemoteToLocal();
    }
  }

  private mergeRemoteToLocal(): void {
    if (!this.localDoc || !this.remoteDoc) return;

    const beforeText = this.localDoc.getText('content').toString();

    const update = Y.encodeStateAsUpdate(
      this.remoteDoc,
      Y.encodeStateVector(this.localDoc)
    );

    Y.applyUpdate(this.localDoc, update, 'remote');

    const afterText = this.localDoc.getText('content').toString();

    if (beforeText !== afterText) {
      const changes = computePositionedChanges(beforeText, afterText);
      this.emitEffect({ type: 'DISPATCH_CM6', changes });
    }
  }

  // ===========================================================================
  // Disk Changes
  // ===========================================================================

  private handleDiskChanged(event: {
    contents: string;
    mtime: number;
    hash: string;
  }): void {
    this._disk = {
      hash: event.hash,
      mtime: event.mtime,
    };

    this.pendingDiskContents = event.contents;

    if (this._statePath === 'active.tracking') {
      // Check synchronously if disk actually changed (comparing hashes)
      // If disk hash matches LCA hash, no change occurred - stay in tracking
      if (this._lca && this._lca.meta.hash === event.hash) {
        // Disk matches LCA - no change, just update mtime
        this._lca = {
          ...this._lca,
          meta: {
            ...this._lca.meta,
            mtime: event.mtime,
          },
        };
        this.emitPersistState();
        return;
      }

      // Check if local content matches disk content - no merge needed
      if (this.localDoc) {
        const localText = this.localDoc.getText('content').toString();
        const lcaText = this._lca?.contents ?? '';

        if (event.contents === localText) {
          // Content matches - create new LCA with disk hash and stay in tracking
          this.createLCAFromCurrent(event.contents, event.hash).then((newLCA) => {
            this._lca = newLCA;
            this.emitPersistState();
          }).catch((err) => {
            this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
          });
          return;
        }

        // Fast-path: if local matches LCA, disk changes can be applied directly
        if (localText === lcaText) {
          // Apply disk content to localDoc synchronously
          this.localDoc.getText('content').delete(0, localText.length);
          this.localDoc.getText('content').insert(0, event.contents);

          // Emit DISPATCH_CM6 synchronously
          this.emitEffect({
            type: 'DISPATCH_CM6',
            changes: this.computeDiffChanges(localText, event.contents),
          });

          // Emit PERSIST_STATE synchronously (with current state)
          this.emitPersistState();

          // Create new LCA with disk content asynchronously
          this.createLCAFromCurrent(event.contents, event.hash).then((newLCA) => {
            this._lca = newLCA;
            // Emit again with updated LCA
            this.emitPersistState();
          }).catch((err) => {
            this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
          });
          return;
        }
      }

      // Actual merge needed - transition to merging
      this.transitionTo('active.merging');
      // Fire-and-forget async merge (state transition already done)
      this.performDiskMerge(event.contents).catch((err) => {
        this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
      });
    } else if (this._statePath.startsWith('idle.')) {
      const remoteChanged = this.hasRemoteChangedSinceLCA();

      if (remoteChanged) {
        this.transitionTo('idle.diverged');
      } else {
        this.transitionTo('idle.diskAhead');
      }

      this.attemptIdleAutoMerge();
    }
  }

  private async performDiskMerge(diskContents: string): Promise<void> {
    if (!this.localDoc) return;

    const localText = this.localDoc.getText('content').toString();
    const lcaText = this._lca?.contents ?? '';
    // Use disk hash if available (from DISK_CHANGED event)
    const diskHash = this._disk?.hash;

    if (diskContents === localText) {
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: await this.createLCAFromCurrent(diskContents, diskHash),
      });
      return;
    }

    if (diskContents === lcaText) {
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this._lca!,
      });
      return;
    }

    if (localText === lcaText) {
      this.applyContentToLocalDoc(diskContents);
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: await this.createLCAFromCurrent(diskContents, diskHash),
      });
      return;
    }

    const mergeResult = performThreeWayMerge(lcaText, localText, diskContents);

    if (mergeResult.success) {
      this.applyContentToLocalDoc(mergeResult.merged);

      if (mergeResult.patches.length > 0) {
        this.emitEffect({ type: 'DISPATCH_CM6', changes: mergeResult.patches });
      }

      this.send({
        type: 'MERGE_SUCCESS',
        // Merged content is new, need to compute hash
        newLCA: await this.createLCAFromCurrent(mergeResult.merged),
      });
    } else {
      this.send({
        type: 'MERGE_CONFLICT',
        base: mergeResult.base,
        local: mergeResult.local,
        remote: mergeResult.remote,
      });
    }
  }

  private applyContentToLocalDoc(newContent: string): void {
    if (!this.localDoc) return;

    const ytext = this.localDoc.getText('content');
    const currentText = ytext.toString();

    if (currentText === newContent) return;

    this.localDoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, newContent);
    }, this);

    this.syncLocalToRemote();
  }

  private async createLCAFromCurrent(contents: string, hash?: string): Promise<LCAState> {
    return {
      contents,
      meta: {
        hash: hash ?? await this.hashFn(contents),
        mtime: this.timeProvider.now(),
      },
      stateVector: this.localDoc
        ? Y.encodeStateVector(this.localDoc)
        : new Uint8Array([0]),
    };
  }

  private handleSaveComplete(event: { mtime: number; hash: string }): void {
    // Update LCA with new mtime and hash
    if (this._lca) {
      this._lca = {
        ...this._lca,
        meta: {
          ...this._lca.meta,
          mtime: event.mtime,
          hash: event.hash,
        },
      };
    }

    // Update disk state to match what we just saved
    // This prevents the next poll from seeing a "change" that is actually our own save
    this._disk = {
      mtime: event.mtime,
      hash: event.hash,
    };

    this.emitPersistState();
  }

  // ===========================================================================
  // Conflict Resolution
  // ===========================================================================

  private handleMergeSuccess(event: { newLCA: LCAState }): void {
    if (this._statePath === 'active.merging') {
      this._lca = event.newLCA;
      this.transitionTo('active.tracking');
      this.emitPersistState();
    }
  }

  private handleMergeConflict(event: {
    base: string;
    local: string;
    remote: string;
  }): void {
    if (this._statePath === 'active.merging') {
      this.conflictData = {
        base: event.base,
        local: event.local,
        remote: event.remote,
      };
      this.transitionTo('active.conflict.bannerShown');
    }
  }

  private handleOpenDiffView(): void {
    if (this._statePath === 'active.conflict.bannerShown') {
      this.transitionTo('active.conflict.resolving');
    }
  }

  private handleCancel(): void {
    if (this._statePath === 'active.conflict.resolving') {
      this.transitionTo('active.conflict.bannerShown');
    }
  }

  private handleResolve(event: MergeEvent): void {
    if (this._statePath !== 'active.conflict.resolving') return;

    // Perform synchronous resolution work first
    switch (event.type) {
      case 'RESOLVE_ACCEPT_DISK':
        if (this.conflictData) {
          const beforeText = this.localDoc?.getText('content').toString() ?? '';
          this.applyContentToLocalDoc(this.conflictData.remote);

          const diskChanges = computePositionedChanges(
            beforeText,
            this.conflictData.remote
          );
          if (diskChanges.length > 0) {
            this.emitEffect({ type: 'DISPATCH_CM6', changes: diskChanges });
          }

          // Async LCA creation (fire-and-forget)
          const diskContent = this.conflictData.remote;
          const diskHash = this._disk?.hash;
          this.createLCAFromCurrent(diskContent, diskHash).then((lca) => {
            this._lca = lca;
            this.emitPersistState();
          }).catch((err) => {
            this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
          });
        }
        break;

      case 'RESOLVE_ACCEPT_LOCAL':
        if (this.localDoc) {
          const localText = this.localDoc.getText('content').toString();
          // Async LCA creation (fire-and-forget)
          this.createLCAFromCurrent(localText).then((lca) => {
            this._lca = lca;
            this.emitPersistState();
          }).catch((err) => {
            this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
          });
        }
        break;

      case 'RESOLVE_ACCEPT_MERGED':
        if ('contents' in event) {
          const beforeText = this.localDoc?.getText('content').toString() ?? '';
          this.applyContentToLocalDoc(event.contents);

          const mergedChanges = computePositionedChanges(beforeText, event.contents);
          if (mergedChanges.length > 0) {
            this.emitEffect({ type: 'DISPATCH_CM6', changes: mergedChanges });
          }

          // Async LCA creation (fire-and-forget)
          const mergedContent = event.contents;
          this.createLCAFromCurrent(mergedContent).then((lca) => {
            this._lca = lca;
            this.emitPersistState();
          }).catch((err) => {
            this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
          });
        }
        break;
    }

    this.conflictData = null;
    this.pendingDiskContents = null;

    // Transition synchronously
    this.transitionTo('active.tracking');
  }

  private handleDismissConflict(): void {
    if (this._statePath !== 'active.conflict.bannerShown') return;

    // Set deferred conflict synchronously with disk hash
    // Local hash will be computed and updated asynchronously
    this._deferredConflict = {
      diskHash: this._disk?.hash ?? '',
      localHash: '', // Will be updated asynchronously
    };

    // Transition synchronously
    this.transitionTo('active.tracking');

    // Emit persist state synchronously (with partial deferred conflict)
    this.emitPersistState();

    // Async computation of local hash (fire-and-forget)
    this.computeLocalHash().then((localHash) => {
      if (this._deferredConflict) {
        this._deferredConflict.localHash = localHash;
        // Emit again with updated hash
        this.emitPersistState();
      }
    }).catch((err) => {
      this.send({ type: 'ERROR', error: err instanceof Error ? err : new Error(String(err)) });
    });
  }

  private async computeLocalHash(): Promise<string> {
    if (!this.localDoc) return '';
    const text = this.localDoc.getText('content').toString();
    return this.hashFn(text);
  }

  // ===========================================================================
  // Connection Events
  // ===========================================================================

  private handleProviderSynced(): void {
    // Provider sync complete - may trigger state updates
  }

  private handleConnected(): void {
    // Network connected
  }

  private handleDisconnected(): void {
    // Network disconnected
  }

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  private handleError(event: { error: Error }): void {
    this._error = event.error;
    if (this._statePath.startsWith('idle.')) {
      this.transitionTo('idle.error');
    }
  }

  // ===========================================================================
  // State Transition Helper
  // ===========================================================================

  private transitionTo(newState: StatePath): void {
    const oldStatus = this.lastSyncStatus;
    this._statePath = newState;
    const newStatus = this.computeSyncStatusType();

    if (oldStatus !== newStatus) {
      this.lastSyncStatus = newStatus;
      this.emitEffect({
        type: 'STATUS_CHANGED',
        guid: this._guid,
        status: this.getSyncStatus(),
      });
    }
  }

  private computeSyncStatusType(): SyncStatusType {
    const statePath = this._statePath;

    if (statePath === 'idle.error' || this._error) {
      return 'error';
    }

    if (statePath.includes('conflict') || statePath === 'idle.diverged') {
      return 'conflict';
    }

    if (
      statePath === 'idle.localAhead' ||
      statePath === 'idle.remoteAhead' ||
      statePath === 'idle.diskAhead' ||
      statePath === 'active.merging'
    ) {
      return 'pending';
    }

    if (statePath === 'idle.clean' || statePath === 'active.tracking') {
      return 'synced';
    }

    if (statePath.startsWith('loading.') || statePath === 'unloading') {
      return 'pending';
    }

    return 'synced';
  }

  // ===========================================================================
  // Diff Computation
  // ===========================================================================

  private computeDiffChanges(from: string, to: string): PositionedChange[] {
    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(from, to);
    dmp.diff_cleanupSemantic(diffs);

    const changes: PositionedChange[] = [];
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

    return this.mergeAdjacentChanges(changes);
  }

  private mergeAdjacentChanges(changes: PositionedChange[]): PositionedChange[] {
    if (changes.length <= 1) return changes;

    const merged: PositionedChange[] = [];
    let current = { ...changes[0] };

    for (let i = 1; i < changes.length; i++) {
      const next = changes[i];
      if (current.to === next.from && current.insert === '') {
        current.to = next.to;
        current.insert = next.insert;
      } else if (current.from === next.from && current.to === current.from) {
        current.to = next.to;
        current.insert += next.insert;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);

    return merged;
  }

  // ===========================================================================
  // Effect Emission
  // ===========================================================================

  private emitEffect(effect: MergeEffect): void {
    this._effects.emit(effect);
  }

  private emitPersistState(): void {
    const persistedState: PersistedMergeState = {
      guid: this._guid,
      path: this._path,
      lca: this._lca
        ? {
            contents: this._lca.contents,
            hash: this._lca.meta.hash,
            mtime: this._lca.meta.mtime,
            stateVector: this._lca.stateVector,
          }
        : null,
      disk: this._disk,
      localStateVector: this._localStateVector,
      lastStatePath: this._statePath,
      deferredConflict: this._deferredConflict,
      persistedAt: this.timeProvider.now(),
    };

    this.emitEffect({
      type: 'PERSIST_STATE',
      guid: this._guid,
      state: persistedState,
    });
  }

  // ===========================================================================
  // State Change Notification
  // ===========================================================================

  private notifyStateChange(
    from: StatePath,
    to: StatePath,
    event: MergeEvent
  ): void {
    // Emit on Observable (per spec)
    this._stateChanges.emit(this.state);

    // Notify legacy listeners (for test harness)
    for (const listener of this.stateChangeListeners) {
      listener(from, to, event);
    }
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function stateVectorsEqual(sv1: Uint8Array, sv2: Uint8Array): boolean {
  if (sv1.length !== sv2.length) return false;
  for (let i = 0; i < sv1.length; i++) {
    if (sv1[i] !== sv2[i]) return false;
  }
  return true;
}

function computePositionedChanges(
  before: string,
  after: string
): PositionedChange[] {
  let prefixLen = 0;
  while (
    prefixLen < before.length &&
    prefixLen < after.length &&
    before[prefixLen] === after[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < before.length - prefixLen &&
    suffixLen < after.length - prefixLen &&
    before[before.length - 1 - suffixLen] === after[after.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const from = prefixLen;
  const to = before.length - suffixLen;
  const insert = after.slice(prefixLen, after.length - suffixLen);

  if (from === to && insert === '') {
    return [];
  }

  return [{ from, to, insert }];
}

function simpleHash(contents: string): string {
  let hash = 0;
  for (let i = 0; i < contents.length; i++) {
    const char = contents.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'hash:' + Math.abs(hash).toString(16);
}

async function defaultHashFn(contents: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(contents);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return simpleHash(contents);
}

// =============================================================================
// 3-Way Merge Implementation
// =============================================================================

function performThreeWayMerge(
  lca: string,
  local: string,
  remote: string
): MergeResult {
  const lcaLines = lca.split('\n');
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');

  const result = diff3Merge(localLines, lcaLines, remoteLines);

  const hasConflict = result.some(
    (region: { ok?: string[]; conflict?: { a: string[]; o: string[]; b: string[] } }) =>
      'conflict' in region
  );

  if (hasConflict) {
    return {
      success: false,
      base: lca,
      local,
      remote,
      conflictRegions: extractConflictRegions(result, lca),
    };
  }

  const mergedLines: string[] = [];
  for (const region of result) {
    if ('ok' in region && region.ok) {
      mergedLines.push(...region.ok);
    }
  }
  const merged = mergedLines.join('\n');

  const patches = computeDiffMatchPatchChanges(local, merged);

  return {
    success: true,
    merged,
    patches,
  };
}

function extractConflictRegions(
  result: Array<{ ok?: string[]; conflict?: { a: string[]; o: string[]; b: string[] } }>,
  base: string
): Array<{ baseStart: number; baseEnd: number; localContent: string; remoteContent: string }> {
  const regions: Array<{
    baseStart: number;
    baseEnd: number;
    localContent: string;
    remoteContent: string;
  }> = [];

  let lineOffset = 0;
  for (const region of result) {
    if ('conflict' in region && region.conflict) {
      const { a: localLines, o: baseLines, b: remoteLines } = region.conflict;
      regions.push({
        baseStart: lineOffset,
        baseEnd: lineOffset + (baseLines?.length ?? 0),
        localContent: localLines?.join('\n') ?? '',
        remoteContent: remoteLines?.join('\n') ?? '',
      });
      lineOffset += baseLines?.length ?? 0;
    } else if ('ok' in region && region.ok) {
      lineOffset += region.ok.length;
    }
  }

  return regions;
}

function computeDiffMatchPatchChanges(
  before: string,
  after: string
): PositionedChange[] {
  if (before === after) return [];

  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);

  const changes: PositionedChange[] = [];
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

  return mergeAdjacentChanges(changes);
}

function mergeAdjacentChanges(changes: PositionedChange[]): PositionedChange[] {
  if (changes.length <= 1) return changes;

  const merged: PositionedChange[] = [];
  let i = 0;

  while (i < changes.length) {
    const current = changes[i];

    if (
      i + 1 < changes.length &&
      current.insert === '' &&
      changes[i + 1].from === current.from &&
      changes[i + 1].to === changes[i + 1].from
    ) {
      merged.push({
        from: current.from,
        to: current.to,
        insert: changes[i + 1].insert,
      });
      i += 2;
    } else {
      merged.push(current);
      i++;
    }
  }

  return merged;
}
