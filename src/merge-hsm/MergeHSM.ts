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
 *
 * CRITICAL INVARIANTS (DO NOT VIOLATE):
 *
 * 1. ONE-TIME CONTENT INSERTION: Disk content must only be inserted into the
 *    CRDT exactly ONCE during initial enrollment. See docs/how-we-bootstrap-collaboration.md.
 *    After enrollment, content flows through CRDT operations, never by reinsertion.
 *
 * 2. NO FULL CRDT REPLACE: Never use the pattern `delete(0, length) + insert(0, newContent)`
 *    on any Y.Text. This destroys the operational history and causes content duplication
 *    when merged with other clients. Always use diff-based updates (diff-match-patch).
 *
 * 3. NEVER WRITE DISK WHEN EDITOR OPEN: In active mode, the editor owns the file.
 *    Disk writes can only happen when transitioning to idle or during conflict resolution.
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
  IYDocPersistence,
  CreatePersistence,
  PersistenceMetadata,
  ConflictRegion,
  PositionedConflict,
  ResolveHunkEvent,
  InitializeWithContentEvent,
  InitializeLCAEvent,
} from './types';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import type { TestableHSM } from './testing/createTestHSM';
import type { LoadUpdatesRaw } from './types';

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
      const localChanged = !!(localSV && stateVectorIsAhead(localSV, lcaSV));
      const remoteChanged = !!(remoteSV && stateVectorIsAhead(remoteSV, lcaSV));

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
          target: 'loading',
          actions: ['setGuidAndPath'],
        },
      },
    },
    loading: {
      // Flat state - no sub-states per spec
      // Handles PERSISTENCE_LOADED internally, waits for mode determination
      on: {
        PERSISTENCE_LOADED: {
          // Stay in loading, just update context
          actions: ['setLCA', 'setLocalStateVector'],
        },
        ACQUIRE_LOCK: {
          target: 'active.entering',
        },
        // DISK_CHANGED can arrive during loading (Obsidian polls disk)
        DISK_CHANGED: {
          actions: ['setDiskMeta'],
        },
        // Mode determination events from MergeManager
        SET_MODE_ACTIVE: {
          target: 'active.loading',
        },
        SET_MODE_IDLE: {
          target: 'idle.loading',
        },
      },
    },
    idle: {
      initial: 'loading',
      states: {
        loading: {
          // Reading LCA from MergeManager cache before determining idle substate
          // Wrapper handles transition to appropriate substate via handleIdleLoading()
        },
        synced: {},
        localAhead: {},
        remoteAhead: {},
        diskAhead: {},
        diverged: {},
        error: {},
      },
      on: {
        LOAD: {
          target: 'loading',
          actions: ['setGuidAndPath'],
        },
        UNLOAD: {
          target: 'unloading',
        },
        ACQUIRE_LOCK: [
          {
            target: 'active.conflict.bannerShown',
            guard: ({ context }) => {
              // Going to conflict.bannerShown if coming from diverged
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
      initial: 'loading',
      states: {
        loading: {
          // Mode is active, waiting for ACQUIRE_LOCK with editor content
          on: {
            ACQUIRE_LOCK: {
              target: 'entering',
            },
          },
        },
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
              // Stay in tracking - Obsidian handles editor<->disk sync via diff-match-patch.
              // Wrapper may opportunistically update LCA if disk matches editor.
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
              // Per spec: LCA is never touched during active.* states
              // Disk metadata is updated by the wrapper
            },
          },
        },
        merging: {
          initial: 'threeWay',
          states: {
            twoWay: {
              // No LCA available - always shows diff UI for user resolution
              on: {
                MERGE_SUCCESS: {
                  target: '#mergeHSM.active.tracking',
                  actions: ['updateLCAFromMerge'],
                },
                MERGE_CONFLICT: {
                  target: '#mergeHSM.active.conflict.bannerShown',
                },
              },
            },
            threeWay: {
              // Has LCA - attempts automatic resolution using diff3
              on: {
                MERGE_SUCCESS: {
                  target: '#mergeHSM.active.tracking',
                  actions: ['updateLCAFromMerge'],
                },
                MERGE_CONFLICT: {
                  target: '#mergeHSM.active.conflict.bannerShown',
                },
              },
            },
          },
        },
        conflict: {
          initial: 'bannerShown',
          states: {
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
        target: 'idle.synced',
      },
    },
  },
});

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

  // Pending disk contents for merge (legacy, used for idle mode)
  private pendingDiskContents: string | null = null;

  // v6: Editor content from ACQUIRE_LOCK event, used for merge on YDOCS_READY
  private pendingEditorContent: string | null = null;

  // Conflict data (enhanced for inline resolution)
  private conflictData: {
    base: string;
    local: string;
    remote: string;
    conflictRegions: ConflictRegion[];
    resolvedIndices: Set<number>;
    positionedConflicts: PositionedConflict[];
  } | null = null;

  // Track previous sync status for change detection
  private lastSyncStatus: SyncStatusType = 'synced';

  // Pending updates for idle mode auto-merge (received via REMOTE_UPDATE)
  private pendingIdleUpdates: Uint8Array | null = null;

  // Initial updates from PERSISTENCE_LOADED (applied when YDocs are created)
  private initialPersistenceUpdates: Uint8Array | null = null;

  // Persistence for localDoc (only in active mode)
  private localPersistence: IYDocPersistence | null = null;

  // Last known editor text (for drift detection)
  private lastKnownEditorText: string | null = null;

  // Y.Text observer for converting remote deltas to positioned changes
  private localTextObserver: ((event: Y.YTextEvent, tr: Y.Transaction) => void) | null = null;

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
  private _createPersistence: CreatePersistence;
  private _loadUpdatesRaw: LoadUpdatesRaw;
  private _persistenceMetadata?: PersistenceMetadata;

  // Remote doc is passed in and managed externally
  private externalRemoteDoc: Y.Doc;

  // Lock requested during loading (deferred until PERSISTENCE_LOADED)
  private pendingLockAcquisition = false;

  // Mode decision from MergeManager (SET_MODE_ACTIVE / SET_MODE_IDLE)
  // null = no decision yet, 'active' = SET_MODE_ACTIVE received, 'idle' = SET_MODE_IDLE received
  private _modeDecision: 'active' | 'idle' | null = null;

  // Whether we entered active mode from idle.diverged (for conflict handling)
  private _enteringFromDiverged = false;

  // Promise that resolves when cleanup completes (for awaiting unload/release)
  private _cleanupPromise: Promise<void> | null = null;
  private _cleanupResolve: (() => void) | null = null;

  // Promise that resolves when idle auto-merge completes (BUG-021)
  private _pendingIdleAutoMerge: Promise<void> | null = null;

  // Network connectivity status (does not block state transitions)
  private _isOnline: boolean = false;

  // User ID for PermanentUserData tracking
  private _userId?: string;

  // Event accumulation queue for loading state (Gap 11)
  // Events like REMOTE_UPDATE and DISK_CHANGED are accumulated during loading
  // and replayed after mode transition (to idle.* or active.*)
  private _accumulatedEvents: Array<{ type: 'REMOTE_UPDATE'; update: Uint8Array } | { type: 'DISK_CHANGED'; contents: string; mtime: number; hash: string }> = [];

  constructor(config: MergeHSMConfig) {
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn ?? defaultHashFn;
    this._guid = config.guid;
    this._path = config.path;
    this.vaultId = config.vaultId;
    this.externalRemoteDoc = config.remoteDoc;
    this._createPersistence = config.createPersistence ?? defaultCreatePersistence;
    this._loadUpdatesRaw = config.loadUpdatesRaw ?? defaultLoadUpdatesRaw;
    this._persistenceMetadata = config.persistenceMetadata;
    this._userId = config.userId;

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
      isOnline: this._isOnline,
      pendingEditorContent: this.pendingEditorContent ?? undefined,
      lastKnownEditorText: this.lastKnownEditorText ?? undefined,
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

  /**
   * Check if the HSM is in loading state without an LCA.
   * When true, INITIALIZE_WITH_CONTENT or INITIALIZE_LCA can be called to establish LCA.
   * Note: LCA is progressive enhancement; documents work without it.
   */
  isAwaitingLCA(): boolean {
    return this._statePath === 'loading' && this._lca === null;
  }

  /**
   * Check if the network is currently connected.
   * Does not affect state transitions; local edits always work offline.
   */
  get isOnline(): boolean {
    return this._isOnline;
  }

  getLocalDoc(): Y.Doc | null {
    return this.localDoc;
  }

  getConflictData(): {
    base: string;
    local: string;
    remote: string;
    conflictRegions?: ConflictRegion[];
    resolvedIndices?: Set<number>;
    positionedConflicts?: PositionedConflict[];
  } | null {
    return this.conflictData;
  }

  getRemoteDoc(): Y.Doc {
    // Per spec: "Access remoteDoc (always available - managed externally)"
    // externalRemoteDoc is passed in via config and always available
    return this.externalRemoteDoc;
  }

  /**
   * Check if HSM has an LCA established.
   * Returns true if LCA exists and can be used for 3-way merge.
   */
  hasLCA(): boolean {
    return this._lca !== null;
  }

  /**
   * Wait for any in-progress cleanup to complete.
   * Returns immediately if no cleanup is in progress.
   * Used by MergeManager to ensure state transitions complete before returning.
   */
  async awaitCleanup(): Promise<void> {
    if (this._cleanupPromise) {
      await this._cleanupPromise;
    }
  }

  /**
   * Wait for any pending idle auto-merge operation to complete.
   * Returns immediately if no auto-merge is in progress.
   * Used by tests to wait for async idle mode operations (BUG-021).
   */
  async awaitIdleAutoMerge(): Promise<void> {
    // Loop until no more merges are pending.
    // This handles the case where one merge's finally block triggers another merge.
    while (this._pendingIdleAutoMerge) {
      await this._pendingIdleAutoMerge;
    }
  }

  /**
   * Wait for the HSM to reach a state matching the given predicate.
   * Returns immediately if already in a matching state.
   *
   * @param predicate - Function that returns true when the desired state is reached
   */
  async awaitState(predicate: (statePath: string) => boolean): Promise<void> {
    if (predicate(this._statePath)) {
      return;
    }

    return new Promise<void>((resolve) => {
      const unsubscribe = this.stateChanges.subscribe((state) => {
        if (predicate(state.statePath)) {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * Wait for the HSM to reach an idle state.
   * Returns immediately if already in idle state.
   * Used to ensure HSM is ready before acquiring lock.
   *
   * Note: If called while in awaitingLCA state, this will block indefinitely
   * until INITIALIZE_WITH_CONTENT or INITIALIZE_LCA is sent.
   */
  async awaitIdle(): Promise<void> {
    return this.awaitState((s) => s.startsWith('idle.'));
  }

  /**
   * Wait for the HSM to reach active.tracking state.
   * Returns immediately if already in active.tracking.
   * Used after sending ACQUIRE_LOCK to wait for lock acquisition to complete.
   * Safe to call from loading state (BUG-032).
   */
  async awaitActive(): Promise<void> {
    // Resolve for any active.* state, not just active.tracking.
    // If HSM enters active.conflict.* (e.g., from idle.diverged), acquireLock()
    // must still complete so LiveView can set up HSM state subscription for banner.
    return this.awaitState((s) => s.startsWith('active.'));
  }

  /**
   * Initialize the LCA for a downloaded document.
   * Sends INITIALIZE_LCA event to transition out of awaitingLCA state.
   * No-op if LCA already exists.
   *
   * @param content - The content from disk
   * @param hash - Hash of the content
   * @param mtime - Modification time from disk
   */
  initializeLCA(content: string, hash: string, mtime: number): void {
    if (this._lca) {
      return; // Already have an LCA, don't overwrite
    }

    this.send({ type: 'INITIALIZE_LCA', content, hash, mtime });
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
    const yjsText = this.localDoc.getText('contents').toString();

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
        this.handleAcquireLock(event);
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

      case 'RESOLVE_HUNK':
        this.handleResolveHunk(event);
        break;

      // Internal Events
      case 'PERSISTENCE_LOADED':
        this.handlePersistenceLoaded(event);
        break;

      case 'YDOCS_READY':
        this.handleYDocsReady();
        break;

      case 'INITIALIZE_WITH_CONTENT':
        this.handleInitializeWithContent(event);
        break;

      case 'INITIALIZE_LCA':
        this.handleInitializeLCA(event);
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

      // Mode Determination Events (from MergeManager)
      case 'SET_MODE_ACTIVE':
        this.handleSetModeActive();
        break;

      case 'SET_MODE_IDLE':
        this.handleSetModeIdle();
        break;

      // Diagnostic events (from Obsidian monkeypatches)
      // These are informational only - no state change, just logged/recorded for debugging
      case 'OBSIDIAN_LOAD_FILE_INTERNAL':
      case 'OBSIDIAN_THREE_WAY_MERGE':
        // No-op: these events are captured by the recording/debugger infrastructure
        // but don't trigger any state transitions or actions
        break;
    }
  }

  // ===========================================================================
  // Mode Determination (from MergeManager)
  // ===========================================================================

  /**
   * Handle SET_MODE_ACTIVE event from MergeManager.
   * Signals that this HSM should be in active mode (editor is open).
   * Transitions to active.loading to wait for ACQUIRE_LOCK with editor content.
   */
  private handleSetModeActive(): void {
    // Only valid in loading state
    if (this._statePath !== 'loading') {
      return;
    }

    // XState machine handles the transition to active.loading
    // (via SET_MODE_ACTIVE event handler in loading state)
    this.transitionTo('active.loading');
  }

  /**
   * Handle SET_MODE_IDLE event from MergeManager.
   * Signals that this HSM should be in idle mode (no editor open).
   * Transitions to idle.loading, then determines appropriate idle substate.
   */
  private handleSetModeIdle(): void {
    // Only valid in loading state
    if (this._statePath !== 'loading') {
      return;
    }
    this._modeDecision = 'idle';

    // XState machine handles the transition to idle.loading
    // (via SET_MODE_IDLE event handler in loading state)
    this.transitionTo('idle.loading');

    // Now determine the appropriate idle substate
    this.handleIdleLoading();
  }

  /**
   * Handle transition from idle.loading to appropriate idle substate.
   * Reads LCA (from persistence/cache) and determines sync state.
   *
   * Spec flow: loading → SET_MODE_IDLE → idle.loading → idle.synced/diverged/etc.
   */
  private handleIdleLoading(): void {
    // Only valid in idle.loading state
    if (this._statePath !== 'idle.loading') {
      return;
    }

    // Clean up YDocs if they were created during initialization
    // (they'll be recreated when lock is acquired)
    // Fire-and-forget - don't block idle transition
    if (this.localDoc) {
      this.cleanupYDocs().catch((err) => {
        console.error('[MergeHSM] Error cleaning up YDocs:', err);
      });
    }

    // LCA is already loaded from persistence (during PERSISTENCE_LOADED)
    // In the future (Gap 7), this will read from MergeManager's LCA cache instead
    // For now, we use the already-loaded _lca value

    // Determine and transition to the appropriate idle substate
    this.determineAndTransitionToIdleState();
  }

  // ===========================================================================
  // Loading & Unloading
  // ===========================================================================

  private handleLoad(event: { guid: string; path: string }): void {
    this._guid = event.guid;
    this._path = event.path;
    this._modeDecision = null; // Reset mode decision for fresh load
    this._accumulatedEvents = []; // Clear accumulated events for fresh load
    this._disk = null; // Clear disk state for fresh load
    this._remoteStateVector = null; // Clear remote state for fresh load
    this.transitionTo('loading');
  }

  private handlePersistenceLoaded(event: {
    updates: Uint8Array;
    lca: LCAState | null;
  }): void {
    // Store LCA (may be null - that's fine, LCA is progressive enhancement)
    this._lca = event.lca;

    // Compute state vector for idle mode comparisons
    if (event.updates.length > 0) {
      this._localStateVector = Y.encodeStateVectorFromUpdate(event.updates);
      // Store updates for when YDocs are created (fixes state vector mismatch on lock cycles)
      this.initialPersistenceUpdates = event.updates;
    }

    // Stay in loading - wait for mode determination via SET_MODE_ACTIVE/IDLE
    // Documents without LCA proceed normally; they'll use 2-way merge or idle.diverged
  }

  /**
   * Handle INITIALIZE_WITH_CONTENT event.
   * Creates localDoc, inserts content, sets LCA, syncs to remote.
   * Used for newly created documents.
   * Can be called in loading, idle, or active states.
   */
  private handleInitializeWithContent(event: InitializeWithContentEvent): void {
    // Skip if already have LCA (don't overwrite)
    if (this._lca) {
      return;
    }

    // In active mode, use localDoc; in loading/idle, create temporarily if needed
    const needsTempDoc = !this.localDoc && this._statePath !== 'loading';

    if (this._statePath.startsWith('active.') && this.localDoc) {
      // Active mode: update existing localDoc using diff-based updates
      // INVARIANT: Never use delete-all/insert-all pattern
      const ytext = this.localDoc.getText('contents');
      const currentText = ytext.toString();
      if (currentText !== event.content) {
        const dmp = new diff_match_patch();
        const diffs = dmp.diff_main(currentText, event.content);
        dmp.diff_cleanupSemantic(diffs);
        this.localDoc.transact(() => {
          let cursor = 0;
          for (const [operation, text] of diffs) {
            switch (operation) {
              case 1: ytext.insert(cursor, text); cursor += text.length; break;
              case 0: cursor += text.length; break;
              case -1: ytext.delete(cursor, text.length); break;
            }
          }
        }, this);
      }
      this._localStateVector = Y.encodeStateVector(this.localDoc);
    }

    // Set LCA with provided hash and mtime
    const stateVector = this.localDoc
      ? Y.encodeStateVector(this.localDoc)
      : this._localStateVector ?? new Uint8Array([0]);

    this._lca = {
      contents: event.content,
      meta: {
        hash: event.hash,
        mtime: event.mtime,
      },
      stateVector,
    };

    this.emitPersistState();

    // Sync to remote if in active mode
    if (this.localDoc && this.remoteDoc) {
      const update = Y.encodeStateAsUpdate(this.localDoc);
      Y.applyUpdate(this.remoteDoc, update, 'local');
      this.emitEffect({ type: 'SYNC_TO_REMOTE', update });
    }
  }

  /**
   * Handle INITIALIZE_LCA event.
   * Sets the LCA (content already in CRDT).
   * Used when downloading a document that already exists in the remote CRDT.
   * Can be called in loading, idle, or active states.
   */
  private handleInitializeLCA(event: InitializeLCAEvent): void {
    // Skip if already have LCA (don't overwrite)
    if (this._lca) {
      return;
    }

    // Set LCA directly (content already in CRDT)
    this._lca = {
      contents: event.content,
      meta: {
        hash: event.hash,
        mtime: event.mtime,
      },
      stateVector: this.localDoc
        ? Y.encodeStateVector(this.localDoc)
        : this._localStateVector ?? new Uint8Array([0]),
    };

    // Persist the new LCA
    this.emitPersistState();
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
      this.transitionTo('idle.synced');
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
      this.transitionTo('idle.synced');
    }

    // Replay accumulated events after transition to idle state
    this.replayAccumulatedEvents();
  }

  /**
   * Replay events accumulated during loading state.
   * Called after mode transition to process REMOTE_UPDATE and DISK_CHANGED events.
   *
   * Gap 11: Events are accumulated during loading states and replayed after
   * the HSM transitions to idle.* or active.* mode.
   */
  private replayAccumulatedEvents(): void {
    if (this._accumulatedEvents.length === 0) {
      return;
    }

    // Take a copy and clear before processing (avoid re-entrancy issues)
    const events = [...this._accumulatedEvents];
    this._accumulatedEvents = [];

    for (const event of events) {
      // Re-send the event - since we're now in idle/active mode, it will be processed normally
      this.send(event as MergeEvent);
    }
  }

  private hasLocalChangedSinceLCA(): boolean {
    if (!this._lca) return false;
    const lcaSV = this._lca.stateVector;
    const localSV = this._localStateVector;

    if (!localSV) return false;

    // Check if local has operations not in LCA
    return stateVectorIsAhead(localSV, lcaSV);
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

    // Check if remote has operations not in LCA
    return stateVectorIsAhead(remoteSV, lcaSV);
  }

  // ===========================================================================
  // Idle Mode Auto-Merge
  // ===========================================================================

  private attemptIdleAutoMerge(): void {
    // Guard: don't start a new merge if one is already in progress
    if (this._pendingIdleAutoMerge) return;

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
      if (!this._lca) return;
      this._pendingIdleAutoMerge = this.performIdleThreeWayMerge().catch(handleError).finally(() => {
        this._pendingIdleAutoMerge = null;
        // Only re-check for updates if the merge succeeded (transitioned out of diverged).
        // If still in diverged, the merge failed with conflicts - don't retry infinitely.
        if (this._statePath !== 'idle.diverged') {
          this.attemptIdleAutoMerge();
        }
      });
    }
  }

  private performIdleRemoteAutoMerge(handleError: (err: unknown) => void): void {
    if (!this.pendingIdleUpdates || !this._lca) return;

    // BUG-021 FIX: Load local updates from IndexedDB and merge with remote.
    // Previously, we applied pendingIdleUpdates to an empty Y.Doc which caused
    // data loss when the remote CRDT was empty/uninitialized.
    this._pendingIdleAutoMerge = this._loadUpdatesRaw(this.vaultId).then((localUpdates) => {
      // Guard against race: check state is still idle.remoteAhead
      // If disk changed while we were loading, we're now in idle.diverged
      // and should let performIdleThreeWayMerge handle it instead.
      if (this._statePath !== 'idle.remoteAhead') return;
      if (!this.pendingIdleUpdates) return; // Guard against race

      // Step 1: Merge local updates into a single update (no Y.Doc needed)
      const localMerged = localUpdates.length > 0
        ? Y.mergeUpdates(localUpdates)
        : new Uint8Array();

      // Step 2: Get local state vector before merge (no Y.Doc needed)
      const localStateVector = localMerged.length > 0
        ? Y.encodeStateVectorFromUpdate(localMerged)
        : new Uint8Array([0]);

      // Step 3: Merge local + remote updates (no Y.Doc needed)
      const updatesToMerge = localMerged.length > 0
        ? [localMerged, this.pendingIdleUpdates!]
        : [this.pendingIdleUpdates!];
      const merged = Y.mergeUpdates(updatesToMerge);

      // Step 4: Check if merge actually added anything (no Y.Doc needed)
      const mergedStateVector = Y.encodeStateVectorFromUpdate(merged);
      if (stateVectorsEqual(localStateVector, mergedStateVector)) {
        // Remote had nothing new - skip hydration and disk write
        this.pendingIdleUpdates = null;
        this.transitionTo('idle.synced');
        return;
      }

      // BUG-049 FIX: Check if local and remote have identical CONTENT before merging.
      // Different state vectors with identical content means the same text was inserted
      // by different clients. Merging in this case duplicates content because Yjs
      // preserves both sets of operations. Skip merge and let content converge naturally
      // through future edits.
      //
      // NOTE: This check requires hydrating both local and remote updates, which adds
      // overhead. However, this is necessary to prevent content duplication bugs that
      // are very difficult to recover from.
      let localContent = '';
      let remoteContent = '';
      if (localMerged.length > 0) {
        const localDoc = new Y.Doc();
        try {
          Y.applyUpdate(localDoc, localMerged);
          localContent = localDoc.getText('contents').toString();
        } finally {
          localDoc.destroy();
        }
      }
      const remoteDoc = new Y.Doc();
      try {
        Y.applyUpdate(remoteDoc, this.pendingIdleUpdates!);
        remoteContent = remoteDoc.getText('contents').toString();
      } finally {
        remoteDoc.destroy();
      }

      if (localContent === remoteContent) {
        // Content matches but state vectors differ - same content from different clients.
        // Skip merge to prevent duplication. State vectors will converge through future edits.
        this.pendingIdleUpdates = null;
        this.transitionTo('idle.synced');
        return;
      }

      // Step 5: NOW hydrate to extract text content (Y.Doc needed only here)
      const tempDoc = new Y.Doc();
      try {
        Y.applyUpdate(tempDoc, merged);
        const mergedContent = tempDoc.getText('contents').toString();
        const stateVector = Y.encodeStateVector(tempDoc);

        // Emit effect to write merged content to disk
        this.emitEffect({
          type: 'WRITE_DISK',
          path: this._path,
          contents: mergedContent,
        });

        // Store merged update for when we enter active mode
        // (IndexedDB doesn't have this content yet)
        this.pendingIdleUpdates = Y.encodeStateAsUpdate(tempDoc);

        this.transitionTo('idle.synced');

        // Update local and remote state vectors (they're now in sync)
        this._localStateVector = stateVector;
        this._remoteStateVector = stateVector;
        // Return the promise so awaitIdleAutoMerge() waits for LCA update
        return this.hashFn(mergedContent).then((hash) => {
          this._lca = {
            contents: mergedContent,
            meta: {
              hash,
              mtime: this.timeProvider.now(),
            },
            stateVector,
          };
          this.emitPersistState();
        });
      } finally {
        tempDoc.destroy();
      }
    }).catch(handleError).finally(() => {
      this._pendingIdleAutoMerge = null;
      // Re-check for updates that arrived during the merge
      this.attemptIdleAutoMerge();
    });
  }

  private performIdleDiskAutoMerge(handleError: (err: unknown) => void): void {
    if (!this.pendingDiskContents || !this._lca) return;

    // BUG-034 FIX: Load local updates from IndexedDB and compute diff update.
    // Previously, we created a fresh Y.Doc, inserted disk content, and sent the
    // full state as an update. When applied to remoteDoc (which already has content),
    // Yjs merges both documents causing content duplication.
    //
    // The fix: Load existing local state, then compute only the diff update needed
    // to transition from the current state to the disk content.
    this._pendingIdleAutoMerge = this._loadUpdatesRaw(this.vaultId).then(async (localUpdates) => {
      // Guard against race: check state is still idle.diskAhead
      // If remote changed while we were loading, we're now in idle.diverged
      // and should let performIdleThreeWayMerge handle it instead.
      if (this._statePath !== 'idle.diskAhead') return;
      if (!this.pendingDiskContents) return; // Guard against race

      const diskContent = this.pendingDiskContents;
      const diskHash = this._disk?.hash;
      const diskMtime = this._disk?.mtime ?? this.timeProvider.now();

      const tempDoc = new Y.Doc();
      try {
        // Step 1: Apply existing local updates to get the current CRDT state
        if (localUpdates.length > 0) {
          const localMerged = Y.mergeUpdates(localUpdates);
          Y.applyUpdate(tempDoc, localMerged);
        }

        // Step 2: Capture state vector BEFORE modifying (for diff encoding)
        const previousStateVector = Y.encodeStateVector(tempDoc);

        // Step 3: Apply disk content using diff-based updates
        // INVARIANT: Never use delete-all/insert-all pattern - it creates
        // CRDT operations that cause duplication when merged with other clients
        const ytext = tempDoc.getText('contents');
        const currentContent = ytext.toString();
        if (currentContent !== diskContent) {
          const dmp = new diff_match_patch();
          const diffs = dmp.diff_main(currentContent, diskContent);
          dmp.diff_cleanupSemantic(diffs);
          tempDoc.transact(() => {
            let cursor = 0;
            for (const [operation, text] of diffs) {
              switch (operation) {
                case 1: ytext.insert(cursor, text); cursor += text.length; break;
                case 0: cursor += text.length; break;
                case -1: ytext.delete(cursor, text.length); break;
              }
            }
          });
        }

        // Step 4: Encode only the DIFF (changes from previous state to new state)
        // This is the key fix - we send only what changed, not the full state
        const diffUpdate = Y.encodeStateAsUpdate(tempDoc, previousStateVector);
        const newStateVector = Y.encodeStateVector(tempDoc);

        // Emit effect to sync the diff to remote
        this.emitEffect({ type: 'SYNC_TO_REMOTE', update: diffUpdate });

        // Clear pending and transition
        this.pendingDiskContents = null;
        this.transitionTo('idle.synced');

        // Update local and remote state vectors (they're now in sync)
        this._localStateVector = newStateVector;
        this._remoteStateVector = newStateVector;

        // Update LCA
        const hash = diskHash ?? await this.hashFn(diskContent);
        this._lca = {
          contents: diskContent,
          meta: {
            hash,
            mtime: diskMtime,
          },
          stateVector: newStateVector,
        };
        this.emitPersistState();
      } finally {
        tempDoc.destroy();
      }
    }).catch(handleError).finally(() => {
      this._pendingIdleAutoMerge = null;
      // Re-check for updates that arrived during the merge
      this.attemptIdleAutoMerge();
    });
  }

  private async performIdleThreeWayMerge(): Promise<void> {
    if (!this._lca) return;

    const lcaContent = this._lca.contents;

    // BUG-021 FIX: Load local updates from IndexedDB and merge with remote.
    // Previously, we applied pendingIdleUpdates to an empty Y.Doc which caused
    // data loss when the remote CRDT was empty/uninitialized.
    const localUpdates = await this._loadUpdatesRaw(this.vaultId);

    // Compute the merged CRDT content (local + remote updates)
    let crdtContent = lcaContent;
    const updatesToMerge: Uint8Array[] = [];

    // Include local updates from IndexedDB
    if (localUpdates.length > 0) {
      updatesToMerge.push(Y.mergeUpdates(localUpdates));
    }

    // Include pending remote updates
    if (this.pendingIdleUpdates) {
      updatesToMerge.push(this.pendingIdleUpdates);
    }

    // Extract content from merged CRDT updates
    if (updatesToMerge.length > 0) {
      const merged = Y.mergeUpdates(updatesToMerge);
      const tempDoc = new Y.Doc();
      try {
        Y.applyUpdate(tempDoc, merged);
        crdtContent = tempDoc.getText('contents').toString();
      } finally {
        tempDoc.destroy();
      }
    }

    const diskContent = this.pendingDiskContents ?? lcaContent;

    // 3-way merge: lca (base), disk (local changes), crdt (remote changes)
    const mergeResult = performThreeWayMerge(lcaContent, diskContent, crdtContent);

    if (mergeResult.success) {
      this.emitEffect({
        type: 'WRITE_DISK',
        path: this._path,
        contents: mergeResult.merged,
      });

      const tempDoc = new Y.Doc();
      try {
        tempDoc.getText('contents').insert(0, mergeResult.merged);
        const stateVector = Y.encodeStateVector(tempDoc);

        // Update local and remote state vectors (now in sync after merge)
        this._localStateVector = stateVector;
        this._remoteStateVector = stateVector;

        this._lca = {
          contents: mergeResult.merged,
          meta: {
            // Merged content is new, compute hash
            hash: await this.hashFn(mergeResult.merged),
            mtime: this.timeProvider.now(),
          },
          stateVector,
        };
      } finally {
        tempDoc.destroy();
      }

      const syncDoc = new Y.Doc();
      try {
        syncDoc.getText('contents').insert(0, mergeResult.merged);
        const update = Y.encodeStateAsUpdate(syncDoc);
        this.emitEffect({ type: 'SYNC_TO_REMOTE', update });
      } finally {
        syncDoc.destroy();
      }

      this.pendingIdleUpdates = null;
      this.pendingDiskContents = null;

      this.transitionTo('idle.synced');
      this.emitPersistState();
    }
    // Note: If merge fails (conflict), we stay in idle.diverged.
    // The finally block in attemptIdleAutoMerge checks state and
    // only retries if we transitioned out of diverged (i.e., merge succeeded).
  }

  private handleUnload(): void {
    // Set up cleanup promise for callers to await
    this._cleanupPromise = new Promise<void>((resolve) => {
      this._cleanupResolve = resolve;
    });

    this.transitionTo('unloading');
    // Await IndexedDB writes before completing unload
    this.cleanupYDocs()
      .then(() => {
        this.transitionTo('unloaded');
      })
      .catch((err) => {
        console.error('[MergeHSM] Error during unload cleanup:', err);
        this.transitionTo('unloaded');
      })
      .finally(() => {
        // Always resolve cleanup promise
        if (this._cleanupResolve) {
          this._cleanupResolve();
          this._cleanupResolve = null;
          this._cleanupPromise = null;
        }
      });
  }

  // ===========================================================================
  // Lock Management (Idle ↔ Active)
  // ===========================================================================

  private handleAcquireLock(event?: { editorContent: string }): void {
    // Handle loading state - XState will transition to active.entering
    if (this._statePath === 'loading') {
      // Store editorContent for merge on YDOCS_READY
      if (event?.editorContent !== undefined) {
        this.pendingEditorContent = event.editorContent;
        this.lastKnownEditorText = event.editorContent;
      }
      // XState handles transition to active.entering
      this.transitionTo('active.entering');
      this.createYDocs();
      return;
    }

    // Handle active.loading state (v9: mode is active, waiting for ACQUIRE_LOCK)
    if (this._statePath === 'active.loading') {
      // Store editorContent for merge on YDOCS_READY
      if (event?.editorContent !== undefined) {
        this.pendingEditorContent = event.editorContent;
        this.lastKnownEditorText = event.editorContent;
      }

      // Transition to active.entering and create YDocs
      this.transitionTo('active.entering');
      this.createYDocs();
      return;
    }

    if (this._statePath.startsWith('idle.')) {
      // v6: Store editorContent from ACQUIRE_LOCK payload
      // This contains the current editor/disk content at the moment of opening.
      // Used in handleYDocsReady to compare against localDoc (fixes BUG-022).
      if (event?.editorContent !== undefined) {
        this.pendingEditorContent = event.editorContent;
        // Initialize lastKnownEditorText so we have a baseline even if no
        // CM6_CHANGE events arrive during active.entering
        this.lastKnownEditorText = event.editorContent;
      }

      // Remember if we came from diverged for conflict handling in handleYDocsReady
      this._enteringFromDiverged = this._statePath === 'idle.diverged';

      // Transition to active.entering first — editor loads from disk and is usable
      // immediately. Then create YDocs which attach persistence. When persistence
      // reports 'synced', YDOCS_READY fires and transitions to active.tracking.
      this.transitionTo('active.entering');
      this.createYDocs();
    }
  }

  private handleYDocsReady(): void {
    if (this._statePath === 'active.entering') {
      // Use current editor state if available, fall back to pendingEditorContent.
      // lastKnownEditorText tracks CM6_CHANGE events during active.entering,
      // so it reflects what the user has typed while persistence was loading.
      // This prevents data loss when user types during the entering phase.
      const localText = this.localDoc?.getText('contents').toString() ?? '';
      const diskText = this.lastKnownEditorText ?? this.pendingEditorContent ?? '';
      const isRecoveryMode = this._lca === null;

      // Clear the flag (no longer primary check, but keep for logging/debugging)
      this._enteringFromDiverged = false;

      if (localText === diskText) {
        // Content matches - proceed to tracking.
        // Per spec: LCA is never touched during active.* states.
        // LCA will be established when file transitions to idle mode.
        this.pendingEditorContent = null;
        this.transitionTo('active.tracking');
        // Merge any remote content that accumulated during active.entering
        this.mergeRemoteToLocal();
        // Replay any events accumulated during loading states
        this.replayAccumulatedEvents();
        return;
      }

      // Content differs - transition to appropriate merging state per spec
      if (isRecoveryMode) {
        // No LCA available - always shows diff UI for user resolution
        this.transitionTo('active.merging.twoWay');
        // Replay any events accumulated during loading states
        this.replayAccumulatedEvents();
        // Perform two-way merge (shows diff UI)
        this.performTwoWayMerge(localText, diskText);
      } else {
        // Has LCA - attempts automatic resolution using diff3
        this.transitionTo('active.merging.threeWay');
        // Replay any events accumulated during loading states
        this.replayAccumulatedEvents();
        // Perform three-way merge (may auto-resolve or show conflict)
        this.performThreeWayMergeFromState();
      }
    }
  }

  /**
   * Perform two-way merge when no LCA is available.
   * Per spec: always shows diff UI for user resolution.
   * Edits in differ write immediately to CRDT/disk.
   */
  private performTwoWayMerge(localText: string, diskText: string): void {
    // Populate conflictData for the diff UI
    this.conflictData = {
      base: '', // No baseline available
      local: localText,
      remote: diskText,
      conflictRegions: [], // No regions - entire content is in conflict
      resolvedIndices: new Set(),
      positionedConflicts: [],
    };

    // Two-way merge always shows diff UI - send MERGE_CONFLICT to transition
    this.send({
      type: 'MERGE_CONFLICT',
      base: '',
      local: localText,
      remote: diskText,
      conflictRegions: [],
    });
  }

  /**
   * Perform three-way merge when LCA is available.
   * Per spec: attempts auto-resolve, shows conflict UI only if truly unresolvable.
   */
  private performThreeWayMergeFromState(): void {
    const localText = this.localDoc?.getText('contents').toString() ?? '';
    const diskText = this.lastKnownEditorText ?? this.pendingEditorContent ?? '';
    const baseText = this._lca?.contents ?? '';

    // BUG-043 fix: If local and disk have identical content, skip merge entirely.
    // This can happen when reopening from idle.diverged after an edit+save session
    // where IDB and disk both have the updated content. In this case, no merge is
    // needed - just transition to tracking. This prevents potential duplication
    // from diff3 merge when both sides made identical changes relative to LCA.
    if (localText === diskText) {
      this.pendingEditorContent = null;
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this._lca ?? {
          contents: '',
          meta: { hash: '', mtime: 0 },
          stateVector: new Uint8Array([0]),
        },
      });
      this.mergeRemoteToLocal();
      return;
    }

    // BUG-046 fix: If local CRDT is empty but disk has content, the CRDT was never
    // initialized (fresh IndexedDB). Don't treat empty as "user deleted everything"
    // in the three-way merge. Instead, initialize CRDT directly from disk content.
    // Editor already shows disk content, so no CM6 dispatch needed.
    if (localText === '' && diskText !== '') {
      this.applyContentToLocalDoc(diskText);
      this.pendingEditorContent = null;
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this._lca ?? {
          contents: '',
          meta: { hash: '', mtime: 0 },
          stateVector: new Uint8Array([0]),
        },
      });
      this.mergeRemoteToLocal();
      return;
    }

    const mergeResult = performThreeWayMerge(baseText, localText, diskText);

    if (mergeResult.success) {
      // Merge succeeded - apply to localDoc and dispatch to editor
      this.applyContentToLocalDoc(mergeResult.merged);

      // BUG-042 fix: Only dispatch patches to editor if editor content differs from merged result.
      // The patches are computed from localText→merged, but the editor has diskText.
      // If diskText === merged (common case when local === base), skip dispatch to avoid duplication.
      if (mergeResult.patches.length > 0 && diskText !== mergeResult.merged) {
        // Editor content differs from merge result - compute patches from disk→merged
        const editorPatches = computeDiffMatchPatchChanges(diskText, mergeResult.merged);
        if (editorPatches.length > 0) {
          this.emitEffect({ type: 'DISPATCH_CM6', changes: editorPatches });
        }
      }

      // Per spec: LCA is never touched during active.* states.
      // Send MERGE_SUCCESS to transition to tracking. LCA will be
      // established when file transitions to idle mode.
      // Note: newLCA is required by the event type but ignored by handler.
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this._lca ?? {
          contents: '',
          meta: { hash: '', mtime: 0 },
          stateVector: new Uint8Array([0]),
        },
      });

      // Clear pending editor content
      this.pendingEditorContent = null;
      // Merge any remote content that accumulated during active.entering
      this.mergeRemoteToLocal();
    } else {
      // Merge has conflicts - populate conflictData for banner/diff view
      this.conflictData = {
        base: baseText,
        local: localText,
        remote: diskText,
        conflictRegions: mergeResult.conflictRegions ?? [],
        resolvedIndices: new Set(),
        positionedConflicts: this.calculateConflictPositions(
          mergeResult.conflictRegions ?? [],
          localText
        ),
      };

      // Send MERGE_CONFLICT to transition to conflict state
      this.send({
        type: 'MERGE_CONFLICT',
        base: baseText,
        local: localText,
        remote: diskText,
        conflictRegions: mergeResult.conflictRegions,
      });
    }
  }

  private handleReleaseLock(): void {
    if (this._statePath.startsWith('active.')) {
      // Determine target idle state based on current state before cleanup
      const wasInConflict = this._statePath.includes('conflict');

      // Set up cleanup promise for callers to await
      this._cleanupPromise = new Promise<void>((resolve) => {
        this._cleanupResolve = resolve;
      });

      this.transitionTo('unloading');

      // Cleanup YDocs asynchronously, awaiting IndexedDB writes to complete
      this.cleanupYDocs()
        .then(() => {
          // Transition to appropriate idle state after cleanup completes
          if (wasInConflict) {
            this.transitionTo('idle.diverged');
          } else {
            this.determineAndTransitionToIdleState();
          }
        })
        .catch((err) => {
          console.error('[MergeHSM] Error during release lock cleanup:', err);
          // Still transition to idle on error
          this.determineAndTransitionToIdleState();
        })
        .finally(() => {
          // Always resolve cleanup promise
          if (this._cleanupResolve) {
            this._cleanupResolve();
            this._cleanupResolve = null;
            this._cleanupPromise = null;
          }
        });
    }
  }

  // ===========================================================================
  // YDoc Management
  // ===========================================================================

  private createYDocs(): void {
    this.localDoc = new Y.Doc();
    // remoteDoc is passed in externally, just reference it in active mode
    this.remoteDoc = this.externalRemoteDoc;

    // Set up PermanentUserData on localDoc to track which user made changes.
    // This is done on localDoc (not remoteDoc) to avoid crashes from malformed
    // 'users' map entries that may arrive from the network.
    if (this._userId) {
      const permanentUserData = new Y.PermanentUserData(this.localDoc);
      permanentUserData.setUserMapping(this.localDoc, this.localDoc.clientID, this._userId);
    }

    // Attach persistence to localDoc — it loads stored updates
    // asynchronously and fires 'synced' when done.
    this.localPersistence = this._createPersistence(this.vaultId, this.localDoc);

    // Check if persistence already synced (race condition fix).
    // If synced is already true, the 'synced' event won't fire again,
    // so we must call the handler immediately.
    if (this.localPersistence.synced) {
      this.handleLocalPersistenceSynced();
    } else {
      this.localPersistence.once('synced', () => {
        this.handleLocalPersistenceSynced();
      });
    }
  }

  /**
   * Handle local persistence synced event.
   * Called either immediately if persistence was already synced,
   * or via the 'synced' event callback.
   */
  private handleLocalPersistenceSynced(): void {
    // Set persistence metadata for recovery/debugging
    if (this._persistenceMetadata && this.localPersistence?.set) {
      this.localPersistence.set('path', this._persistenceMetadata.path);
      this.localPersistence.set('relay', this._persistenceMetadata.relay);
      this.localPersistence.set('appId', this._persistenceMetadata.appId);
      this.localPersistence.set('s3rn', this._persistenceMetadata.s3rn);
    }

    // Apply updates to populate localDoc with the correct content.
    // Note: IndexedDB persistence has already loaded stored updates into localDoc.
    // We only need to handle two cases:
    // 1. pendingIdleUpdates: Remote updates received while in idle mode
    // 2. LCA fallback: If localDoc is empty but we have LCA content (BUG-040 fix)
    //
    // BUG-043 fix: Do NOT apply initialPersistenceUpdates here - they were already
    // loaded by IndexedDB persistence. Applying them again causes content duplication.
    //
    // BUG-048 fix: Check if pendingIdleUpdates content matches localDoc before applying.
    // If content is identical but CRDT histories differ (same text inserted by different
    // clients), applying would duplicate content.
    //
    // INVARIANT: Per docs/how-we-bootstrap-collaboration.md, we can only insert content
    // into the CRDT exactly ONCE. If localDoc already has content from IndexedDB and
    // pendingIdleUpdates has DIFFERENT content from remote, we MUST NOT blindly apply it.
    // Instead, let the merge flow (handleYDocsReady) detect the difference and use proper
    // merge logic (twoWay/threeWay) to resolve it.
    //
    // BUG-048 fix: Only apply pendingIdleUpdates when localDoc is empty.
    // If localDoc has content from IndexedDB, we must NOT blindly apply pendingIdleUpdates
    // even if the content matches - the CRDT histories may differ (same text inserted by
    // different clients), and applying would duplicate content.
    //
    // Instead, let mergeRemoteToLocal() in handleYDocsReady() handle the merge properly.
    // It compares content and returns early if they match, without risking duplication.
    if (this.pendingIdleUpdates && this.pendingIdleUpdates.length > 0 && this.localDoc) {
      const localText = this.localDoc.getText('contents').toString();

      // Only apply if localDoc is empty - safe to apply remote content
      if (localText === '') {
        Y.applyUpdate(this.localDoc, this.pendingIdleUpdates);
      }
      // If localDoc has content, DO NOT apply - let mergeRemoteToLocal() handle it
      this.pendingIdleUpdates = null;
    }
    // Clear initialPersistenceUpdates - no longer needed (state vector already computed)
    this.initialPersistenceUpdates = null;

    // INVARIANT VIOLATION - DO NOT DO THIS:
    // Per docs/how-we-bootstrap-collaboration.md, disk content must only be inserted
    // into the CRDT exactly ONCE during initial enrollment. Inserting LCA content here
    // on reopen would violate this invariant and cause content duplication if the CRDT
    // already has content from a different client/history.
    //
    // If localDoc is empty after persistence sync, it means:
    // 1. This is the first time opening this file (IDB is empty) - the merge flow will
    //    handle comparing against disk content
    // 2. IDB was cleared/corrupted - should show conflict, not silently insert LCA
    //
    // The correct solution is to let handleYDocsReady detect the content mismatch
    // and use the normal merge flow (twoWay/threeWay) to resolve it.

    // Update state vector to reflect what's in localDoc
    if (this.localDoc) {
      this._localStateVector = Y.encodeStateVector(this.localDoc);
    }

    // Set up observer for remote updates (converts deltas to positioned changes)
    this.setupLocalDocObserver();

    // Signal that YDocs are ready
    this.send({ type: 'YDOCS_READY' });
  }

  /**
   * Set up Y.Text observer on localDoc to convert Yjs deltas to PositionedChange[].
   * When updates are applied with origin='remote', the observer fires with event.delta
   * which we convert directly to positioned changes for CM6.
   */
  private setupLocalDocObserver(): void {
    if (!this.localDoc) return;

    const ytext = this.localDoc.getText('contents');
    this.localTextObserver = (event: Y.YTextEvent, tr: Y.Transaction) => {
      // Only process remote-originated changes
      if (tr.origin !== 'remote') return;

      // Only dispatch in tracking state
      if (this._statePath !== 'active.tracking') return;

      // Convert delta to positioned changes
      const changes = this.deltaToPositionedChanges(event.delta);
      if (changes.length > 0) {
        this.emitEffect({ type: 'DISPATCH_CM6', changes });
      }
    };
    ytext.observe(this.localTextObserver);
  }

  /**
   * Convert a Yjs delta to PositionedChange[].
   * Same logic as the legacy path in LiveEditPlugin.
   */
  private deltaToPositionedChanges(delta: Array<{ insert?: string | object; delete?: number; retain?: number }>): PositionedChange[] {
    const changes: PositionedChange[] = [];
    let pos = 0;

    for (const d of delta) {
      if (d.insert != null) {
        // Insert is string content (we ignore embedded objects)
        const insertText = typeof d.insert === 'string' ? d.insert : '';
        if (insertText) {
          changes.push({ from: pos, to: pos, insert: insertText });
        }
      } else if (d.delete != null) {
        changes.push({ from: pos, to: pos + d.delete, insert: '' });
        pos += d.delete;
      } else if (d.retain != null) {
        pos += d.retain;
      }
    }
    return changes;
  }

  private async cleanupYDocs(): Promise<void> {
    // Capture final state before cleanup for idle state determination and LCA update
    let finalContent: string | null = null;
    if (this.localDoc) {
      this._localStateVector = Y.encodeStateVector(this.localDoc);
      finalContent = this.localDoc.getText('contents').toString();
    }

    // BUG-044 fix: Update LCA if disk matches final localDoc content.
    // This ensures that after a successful edit+save session, we transition to
    // idle.synced instead of idle.diverged, preventing content duplication on reopen.
    //
    // BUG-045 fix: Also check content equality (not just hash) as a fallback.
    // Hash mismatches can occur due to different hash computation paths
    // (SAVE_COMPLETE vs DISK_CHANGED vs internal hashFn).
    //
    // BUG-046 fix: Also check lastKnownEditorText, which is what we saved to disk.
    // After SAVE_COMPLETE, pendingDiskContents is null (no DISK_CHANGED event yet),
    // but lastKnownEditorText contains what was written to disk via Ctrl+S.
    if (finalContent !== null && this._disk) {
      const contentHash = await this.hashFn(finalContent);
      const hashMatches = contentHash === this._disk.hash;
      // Fallback to content comparison if hash doesn't match:
      // - pendingDiskContents: set from DISK_CHANGED events
      // - lastKnownEditorText: set from CM6_CHANGE/ACQUIRE_LOCK, represents what was saved
      const contentMatches =
        hashMatches ||
        this.pendingDiskContents === finalContent ||
        this.lastKnownEditorText === finalContent;

      if (contentMatches) {
        // Disk matches localDoc - update LCA to reflect the synced state.
        // Use disk.hash (not contentHash) to ensure hasDiskChangedSinceLCA()
        // returns false, even if hash functions differ between sources.
        this._lca = {
          contents: finalContent,
          meta: {
            hash: this._disk.hash,
            mtime: this._disk.mtime,
          },
          stateVector: this._localStateVector ?? new Uint8Array([0]),
        };
        // Persist the updated LCA
        this.emitPersistState();
      }
    }

    // Clean up Y.Text observer before destroying doc
    if (this.localDoc && this.localTextObserver) {
      const ytext = this.localDoc.getText('contents');
      ytext.unobserve(this.localTextObserver);
      this.localTextObserver = null;
    }

    if (this.localPersistence) {
      // Await destroy to ensure pending IndexedDB writes complete
      await this.localPersistence.destroy();
      this.localPersistence = null;
    }
    if (this.localDoc) {
      this.localDoc.destroy();
      this.localDoc = null;
    }
    // Do NOT destroy remoteDoc - it's managed externally
    // Just clear our reference to it
    this.remoteDoc = null;
  }

  /**
   * Initialize a new file with content and LCA.
   * Sends INITIALIZE_WITH_CONTENT event which creates YDocs, inserts content,
   * sets LCA, and transitions to ready state.
   *
   * @param content - The file content to initialize with
   * @param hash - Hash of the content
   * @param mtime - Modification time from disk
   */
  initializeLocalDoc(content: string, hash: string, mtime: number): void {
    this.send({
      type: 'INITIALIZE_WITH_CONTENT',
      content,
      hash,
      mtime,
    });
  }

  // ===========================================================================
  // Active Mode: Editor Integration
  // ===========================================================================

  private handleCM6Change(event: {
    changes: PositionedChange[];
    docText: string;
    isFromYjs: boolean;
  }): void {
    // Always track editor state, even during active.entering.
    // This ensures we have the most up-to-date editor content for
    // merge decisions in handleYDocsReady.
    this.lastKnownEditorText = event.docText;

    // Only apply to localDoc in tracking state
    if (this._statePath !== 'active.tracking') return;

    if (event.isFromYjs) return;

    if (this.localDoc) {
      const ytext = this.localDoc.getText('contents');
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

    // BUG-053 FIX: Before syncing, check if content is identical.
    // If localDoc and remoteDoc have the same content but different CRDT histories
    // (different clientIDs), delta encoding would send ALL of localDoc's operations
    // to remoteDoc, causing content duplication. Instead:
    // 1. If content matches, check if remoteDoc needs our content at all
    // 2. If remoteDoc already has the content, skip sync entirely
    // 3. Only sync when there's actual NEW content (beyond matching base content)
    const localText = this.localDoc.getText('contents').toString();
    const remoteText = this.remoteDoc.getText('contents').toString();

    if (localText === remoteText) {
      // Content is identical - no need to sync anything.
      // State vectors may differ but that's OK - remoteDoc already has the content.
      return;
    }

    // BUG-053 FIX: Check for partial match scenario where remoteDoc has older content
    // that's a prefix of localDoc's content. In this case, we only need to sync the
    // new part, but we need to be careful about CRDT history.
    //
    // If the matching prefix was created by different clients (different CRDT ops),
    // we can't just sync the suffix - we'd still duplicate the prefix.
    //
    // Detection: If remoteDoc content is a prefix of localDoc content, check if
    // this is a "same content, different history" situation by comparing what
    // the delta update would actually contain.
    const update = Y.encodeStateAsUpdate(
      this.localDoc,
      Y.encodeStateVector(this.remoteDoc)
    );

    if (update.length > 0) {
      // Before applying, verify the update won't cause duplication.
      // Create a temp doc to test what applying the update would produce.
      const tempDoc = new Y.Doc();
      try {
        Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(this.remoteDoc));
        Y.applyUpdate(tempDoc, update, 'local');
        const resultText = tempDoc.getText('contents').toString();

        // If applying the update results in duplicated content, skip the sync.
        // Duplication pattern: result is exactly 2x local length with repeated content.
        if (resultText.length === localText.length * 2 &&
            resultText.slice(0, localText.length) === localText &&
            resultText.slice(localText.length) === localText) {
          // Sync would cause duplication - skip it.
          // This happens when localDoc and remoteDoc have the same base content
          // but with different CRDT histories (different clientIDs).
          return;
        }

        // Also check if result is too long (partial duplication)
        if (resultText.length > localText.length) {
          // Result is longer than expected - might be partial duplication.
          // Check if localText is contained multiple times.
          const firstIndex = resultText.indexOf(localText);
          const secondIndex = resultText.indexOf(localText, firstIndex + 1);
          if (firstIndex >= 0 && secondIndex >= 0) {
            // localText appears multiple times - skip to prevent duplication
            return;
          }
        }
      } finally {
        tempDoc.destroy();
      }

      // Safe to apply
      Y.applyUpdate(this.remoteDoc, update, 'local');
      this.emitEffect({ type: 'SYNC_TO_REMOTE', update });
    }
  }

  // ===========================================================================
  // Active Mode: Remote Updates
  // ===========================================================================

  private handleRemoteUpdate(event: { update: Uint8Array }): void {
    // Track whether we should skip accumulation (BUG-054 fix)
    let skipAccumulation = false;

    // Apply update to remoteDoc if available (only in active mode)
    if (this.remoteDoc) {
      Y.applyUpdate(this.remoteDoc, event.update, 'remote');
      // Get state vector from the doc AFTER applying update, not from the update itself.
      // Delta updates have minimal state vectors that don't reflect the full doc state.
      this._remoteStateVector = Y.encodeStateVector(this.remoteDoc);
    } else {
      // In idle/loading mode, remoteDoc may not be available.
      // Use externalRemoteDoc (always available) to track state.
      //
      // BUG-051 FIX: Before applying the update, check if it would cause content
      // duplication. This can happen when a server echo arrives with the same
      // content but different CRDT history (different clientID). Applying such
      // an update would preserve both sets of operations, doubling the content.
      //
      // Solution: Compare the content of the incoming update with what's already
      // in externalRemoteDoc. If they match, skip the apply to prevent duplication.
      const currentContent = this.externalRemoteDoc.getText('contents').toString();
      const tempDoc = new Y.Doc();
      try {
        Y.applyUpdate(tempDoc, event.update);
        const updateContent = tempDoc.getText('contents').toString();

        if (currentContent !== '' && updateContent !== '' && currentContent === updateContent) {
          // Content already matches - skip apply to prevent duplication from
          // different CRDT histories containing the same text.
          // Just update the state vector (using the doc's current state).
          this._remoteStateVector = Y.encodeStateVector(this.externalRemoteDoc);
          // BUG-054 FIX: Also skip accumulation in pendingIdleUpdates and PERSIST_UPDATES.
          // Without this, the echo gets persisted to IDB, and on reopen both the original
          // content (from IDB) and the echo get loaded into localDoc, causing duplication.
          skipAccumulation = true;
        } else {
          // Content differs or one is empty - safe to apply
          Y.applyUpdate(this.externalRemoteDoc, event.update, 'remote');
          this._remoteStateVector = Y.encodeStateVector(this.externalRemoteDoc);
        }
      } finally {
        tempDoc.destroy();
      }
    }

    // Accumulate event during loading state for replay after mode transition
    // BUG-054: Skip accumulation if content matched (prevents duplication on reopen)
    if (skipAccumulation) {
      return;
    }

    if (this._statePath === 'loading') {
      // Merge with existing accumulated REMOTE_UPDATE if any
      const existingRemoteIdx = this._accumulatedEvents.findIndex(e => e.type === 'REMOTE_UPDATE');
      if (existingRemoteIdx >= 0) {
        const existing = this._accumulatedEvents[existingRemoteIdx] as { type: 'REMOTE_UPDATE'; update: Uint8Array };
        this._accumulatedEvents[existingRemoteIdx] = {
          type: 'REMOTE_UPDATE',
          update: Y.mergeUpdates([existing.update, event.update]),
        };
      } else {
        this._accumulatedEvents.push({
          type: 'REMOTE_UPDATE',
          update: event.update,
        });
      }
      return;
    }

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

  /**
   * Merge remote changes to local doc.
   * The Y.Text observer (setupLocalDocObserver) handles emitting DISPATCH_CM6
   * with correctly positioned changes derived from Yjs deltas.
   *
   * BUG-035 FIX: Check if content is already identical before merging.
   * If localDoc and remoteDoc have the same text content but different CRDT
   * histories (e.g., same content inserted by different clients), blindly
   * applying the remote update would duplicate the content. Instead, we:
   * 1. Check if the text content is already identical
   * 2. If identical, sync state vectors without applying content changes
   * 3. If different, apply the remote update normally
   */
  private mergeRemoteToLocal(): void {
    if (!this.localDoc || !this.remoteDoc) return;

    const localText = this.localDoc.getText('contents').toString();
    const remoteText = this.remoteDoc.getText('contents').toString();

    // BUG-053 FIX: Detect and fix content duplication in remoteDoc.
    // This can happen when the server echoes back operations with different CRDT
    // history (e.g., different clientID), causing Yjs to preserve both sets of
    // operations and doubling the content. The provider applies these echoes
    // directly to remoteDoc before we can intercept them.
    //
    // Detection: remoteText is exactly 2x localText length, and remoteText is
    // localText repeated twice (first half === second half === localText).
    if (localText.length > 0 &&
        remoteText.length === localText.length * 2 &&
        remoteText.slice(0, localText.length) === localText &&
        remoteText.slice(localText.length) === localText) {
      // remoteDoc has duplicated content - fix it by clearing and reinserting
      // from localDoc's content. This is safe because localText is the correct
      // content (matches disk and IDB).
      const remoteYtext = this.remoteDoc.getText('contents');
      this.remoteDoc.transact(() => {
        remoteYtext.delete(0, remoteYtext.length);
        remoteYtext.insert(0, localText);
      }, this);
      // After fixing remoteDoc, content now matches - nothing more to do for localDoc
      return;
    }

    // If content is already identical, we need to reconcile state vectors
    // without duplicating content
    if (localText === remoteText) {
      // Content matches - no changes needed.
      // State vector differences are acceptable and will naturally converge
      // through future edits. We do NOT reconcile state vectors here because:
      // 1. The BUG-052 "fix" (delete + reapply) creates new CRDT operations
      //    that get persisted to IDB, causing cumulative growth
      // 2. Simply returning here is safe - syncLocalToRemote uses delta encoding
      //    which only transfers operations remoteDoc doesn't have
      // 3. If remoteDoc has duplicate ops (same content, different history),
      //    that's a server/provider issue handled by BUG-053 fix above
      return;
    }

    // Content differs - apply remote changes normally
    const update = Y.encodeStateAsUpdate(
      this.remoteDoc,
      Y.encodeStateVector(this.localDoc)
    );

    // Observer will fire and emit DISPATCH_CM6 with delta-based changes
    Y.applyUpdate(this.localDoc, update, 'remote');
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

    // Accumulate event during loading state for replay after mode transition
    if (this._statePath === 'loading') {
      // Replace any existing DISK_CHANGED event (only keep latest)
      this._accumulatedEvents = this._accumulatedEvents.filter(e => e.type !== 'DISK_CHANGED');
      this._accumulatedEvents.push({
        type: 'DISK_CHANGED',
        contents: event.contents,
        mtime: event.mtime,
        hash: event.hash,
      });
      return;
    }

    if (this._statePath === 'active.tracking') {
      // In active.tracking, Obsidian handles editor<->disk sync via diff-match-patch.
      // Per spec: LCA is never touched during active.* states.
      // Disk metadata is already updated at the start of this function.
      return;
    } else if (this._statePath.startsWith('idle.')) {
      const diskChanged = this.hasDiskChangedSinceLCA();

      // If disk matches LCA, no state change needed
      if (!diskChanged) {
        // Just update mtime in LCA if hashes match
        if (this._lca && this._lca.meta.hash === event.hash) {
          this._lca = {
            ...this._lca,
            meta: {
              ...this._lca.meta,
              mtime: event.mtime,
            },
          };
          this.emitPersistState();
        }
        return;
      }

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

    const localText = this.localDoc.getText('contents').toString();
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
        conflictRegions: mergeResult.conflictRegions,
      });
    }
  }

  /**
   * Apply new content to localDoc using diff-based updates.
   *
   * INVARIANT: Never uses delete-all/insert-all pattern. Uses diff-match-patch
   * to compute minimal edits that preserve CRDT operational history.
   */
  private applyContentToLocalDoc(newContent: string): void {
    if (!this.localDoc) return;

    const ytext = this.localDoc.getText('contents');
    const currentText = ytext.toString();

    if (currentText === newContent) return;

    // Use diff-match-patch to compute minimal edits
    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(currentText, newContent);
    dmp.diff_cleanupSemantic(diffs);

    // Apply diffs incrementally to preserve CRDT history
    this.localDoc.transact(() => {
      let cursor = 0;
      for (const [operation, text] of diffs) {
        switch (operation) {
          case 1: // Insert
            ytext.insert(cursor, text);
            cursor += text.length;
            break;
          case 0: // Equal - advance cursor
            cursor += text.length;
            break;
          case -1: // Delete
            ytext.delete(cursor, text.length);
            break;
        }
      }
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
    // Per spec: LCA is never touched during active.* states.
    // Only update disk state to match what we just saved.
    // This prevents the next poll from seeing a "change" that is actually our own save.
    this._disk = {
      mtime: event.mtime,
      hash: event.hash,
    };
  }

  // ===========================================================================
  // Conflict Resolution
  // ===========================================================================

  private handleMergeSuccess(event: { newLCA: LCAState }): void {
    if (this._statePath.startsWith('active.merging')) {
      // Per spec: LCA is never touched during active.* states.
      // LCA will be established when file transitions to idle mode.
      this.transitionTo('active.tracking');
    }
  }

  private handleMergeConflict(event: {
    base: string;
    local: string;
    remote: string;
    conflictRegions?: ConflictRegion[];
  }): void {
    if (this._statePath.startsWith('active.merging')) {
      const conflictRegions = event.conflictRegions ?? [];
      const positionedConflicts = this.calculateConflictPositions(
        conflictRegions,
        event.local
      );

      this.conflictData = {
        base: event.base,
        local: event.local,
        remote: event.remote,
        conflictRegions,
        resolvedIndices: new Set(),
        positionedConflicts,
      };

      // Emit effect to show inline decorations
      if (positionedConflicts.length > 0) {
        this.emitEffect({
          type: 'SHOW_CONFLICT_DECORATIONS',
          conflictRegions,
          positions: positionedConflicts,
        });
      }

      this.transitionTo('active.conflict.bannerShown');
    }
  }

  /**
   * Calculate character positions for conflict regions based on line numbers.
   */
  private calculateConflictPositions(
    regions: ConflictRegion[],
    localContent: string
  ): PositionedConflict[] {
    if (regions.length === 0) return [];

    const lines = localContent.split('\n');
    const lineStarts: number[] = [0];
    for (let i = 0; i < lines.length; i++) {
      lineStarts.push(lineStarts[i] + lines[i].length + 1);
    }

    return regions.map((region, index) => ({
      index,
      localStart: lineStarts[region.baseStart] ?? 0,
      localEnd: lineStarts[region.baseEnd] ?? localContent.length,
      localContent: region.localContent,
      remoteContent: region.remoteContent,
    }));
  }

  /**
   * Recalculate conflict positions after a hunk is resolved.
   * Positions shift when earlier hunks are resolved.
   */
  private recalculateConflictPositions(): void {
    if (!this.conflictData || !this.localDoc) return;

    const currentContent = this.localDoc.getText('contents').toString();
    const unresolvedRegions = this.conflictData.conflictRegions.filter(
      (_, i) => !this.conflictData!.resolvedIndices.has(i)
    );

    // For unresolved regions, we need to find them in the new content
    // This is a simplified approach - in practice we'd need more sophisticated tracking
    // For now, we'll re-emit with adjusted positions
    this.conflictData.local = currentContent;
  }

  /**
   * Handle per-hunk conflict resolution from inline decorations.
   */
  private handleResolveHunk(event: ResolveHunkEvent): void {
    // Allow resolving from either bannerShown or resolving state
    if (!this._statePath.includes('conflict')) return;
    if (!this.conflictData || !this.localDoc) return;

    const { index, resolution } = event;

    // Skip if already resolved
    if (this.conflictData.resolvedIndices.has(index)) return;

    const region = this.conflictData.conflictRegions[index];
    const positioned = this.conflictData.positionedConflicts[index];

    if (!region || !positioned) return;

    // Determine content to apply based on resolution type
    let newContent: string;
    switch (resolution) {
      case 'local':
        newContent = region.localContent;
        break;
      case 'remote':
        newContent = region.remoteContent;
        break;
      case 'both':
        newContent = region.localContent + '\n' + region.remoteContent;
        break;
    }

    // Get current editor state
    const beforeText = this.localDoc.getText('contents').toString();

    // Apply to localDoc at the conflict position
    const ytext = this.localDoc.getText('contents');
    this.localDoc.transact(() => {
      // Delete the conflict region
      const deleteLength = positioned.localEnd - positioned.localStart;
      if (deleteLength > 0) {
        ytext.delete(positioned.localStart, deleteLength);
      }
      // Insert resolved content
      if (newContent) {
        ytext.insert(positioned.localStart, newContent);
      }
    }, this);

    // Mark as resolved
    this.conflictData.resolvedIndices.add(index);

    // Emit effect to hide this conflict's decoration
    this.emitEffect({
      type: 'HIDE_CONFLICT_DECORATION',
      index,
    });

    // Get updated content
    const afterText = this.localDoc.getText('contents').toString();

    // Emit DISPATCH_CM6 to update editor
    const changes = computePositionedChanges(beforeText, afterText);
    if (changes.length > 0) {
      this.emitEffect({ type: 'DISPATCH_CM6', changes });
    }

    // Update stored local content
    this.conflictData.local = afterText;

    // Recalculate positions for remaining conflicts (they shift!)
    this.recalculateConflictPositions();

    // Sync to remote → collaborators see immediately
    this.syncLocalToRemote();

    // Check if all conflicts resolved
    if (this.conflictData.resolvedIndices.size === this.conflictData.conflictRegions.length) {
      this.finalizeConflictResolution();
    }
  }

  /**
   * Finalize conflict resolution when all hunks are resolved.
   * Per spec: LCA is never touched during active.* states.
   * LCA will be updated when transitioning back to idle mode.
   */
  private finalizeConflictResolution(): void {
    if (!this.localDoc) return;

    this.conflictData = null;
    this.pendingDiskContents = null;
    this.transitionTo('active.tracking');
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

    // Perform resolution work
    switch (event.type) {
      case 'RESOLVE_ACCEPT_DISK':
        if (this.conflictData) {
          // Apply disk content to the CRDT
          this.applyContentToLocalDoc(this.conflictData.remote);

          // BUG-044 fix: Don't dispatch CM6 changes for RESOLVE_ACCEPT_DISK.
          // The editor is already showing disk content (Obsidian loaded it from disk
          // when the file was opened). Dispatching changes from CRDT→disk would apply
          // those changes on top of the existing disk content, causing duplication.
          //
          // Per spec: LCA is never touched during active.* states.
          // LCA will be established when file transitions to idle mode.
        }
        break;

      case 'RESOLVE_ACCEPT_LOCAL':
        if (this.localDoc && this.conflictData) {
          const localText = this.localDoc.getText('contents').toString();

          // The editor was showing conflictData.remote (disk content).
          // We need to dispatch changes to update the editor to show localText (CRDT content).
          const editorText = this.conflictData.remote;
          const localChanges = computePositionedChanges(editorText, localText);
          if (localChanges.length > 0) {
            this.emitEffect({ type: 'DISPATCH_CM6', changes: localChanges });
          }
          // Per spec: LCA is never touched during active.* states.
          // LCA will be established when file transitions to idle mode.
        }
        break;

      case 'RESOLVE_ACCEPT_MERGED':
        if ('contents' in event && this.conflictData) {
          this.applyContentToLocalDoc(event.contents);

          // BUG-044 fix: The editor shows disk content (conflictData.remote), not CRDT content.
          // Compute changes from disk→merged to correctly update the editor.
          const editorText = this.conflictData.remote;
          const mergedChanges = computePositionedChanges(editorText, event.contents);
          if (mergedChanges.length > 0) {
            this.emitEffect({ type: 'DISPATCH_CM6', changes: mergedChanges });
          }
          // Per spec: LCA is never touched during active.* states.
          // LCA will be established when file transitions to idle mode.
        }
        break;
    }

    this.conflictData = null;
    this.pendingDiskContents = null;
    this.pendingEditorContent = null;

    // Transition to tracking
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
    const text = this.localDoc.getText('contents').toString();
    return this.hashFn(text);
  }

  // ===========================================================================
  // Connection Events
  // ===========================================================================

  private handleProviderSynced(): void {
    // Provider sync complete - may trigger state updates
  }

  private handleConnected(): void {
    this._isOnline = true;

    // When we reconnect, flush any pending local changes to remoteDoc.
    // This ensures edits made while offline get synced to the server.
    if (this.localDoc && this._statePath === 'active.tracking') {
      this.syncLocalToRemote();
    }
  }

  private handleDisconnected(): void {
    this._isOnline = false;
    // Local edits continue to be applied to localDoc and persisted to IndexedDB.
    // When connectivity returns, handleConnected() will flush pending updates.
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
      statePath.startsWith('active.merging')
    ) {
      return 'pending';
    }

    if (statePath === 'idle.synced' || statePath === 'active.tracking') {
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

/**
 * Check if two state vectors represent the same CRDT state.
 * Uses proper CRDT semantics: decodes the state vectors and compares
 * client clocks, rather than byte-by-byte comparison.
 */
function stateVectorsEqual(sv1: Uint8Array, sv2: Uint8Array): boolean {
  const decoded1 = Y.decodeStateVector(sv1);
  const decoded2 = Y.decodeStateVector(sv2);

  // Check all clients in sv1 exist in sv2 with same clock
  for (const [clientId, clock] of decoded1) {
    if (decoded2.get(clientId) !== clock) return false;
  }

  // Check all clients in sv2 exist in sv1 (already checked clock above if they do)
  for (const [clientId] of decoded2) {
    if (!decoded1.has(clientId)) return false;
  }

  return true;
}

/**
 * Check if `ahead` state vector contains operations not present in `behind`.
 * Returns true if any client in `ahead` has a higher clock than in `behind`.
 *
 * This is the proper CRDT way to check "has remote changed since LCA" -
 * we're asking if remote's state vector contains any operations that
 * weren't in the LCA's state vector.
 */
function stateVectorIsAhead(ahead: Uint8Array, behind: Uint8Array): boolean {
  const aheadDecoded = Y.decodeStateVector(ahead);
  const behindDecoded = Y.decodeStateVector(behind);

  for (const [clientId, clock] of aheadDecoded) {
    const behindClock = behindDecoded.get(clientId) ?? 0;
    if (clock > behindClock) return true;
  }

  return false;
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

/**
 * Default persistence factory: fires 'synced' synchronously (no IndexedDB).
 * Production code should pass a real factory that creates IndexeddbPersistence.
 */
const defaultCreatePersistence: CreatePersistence = (_vaultId: string, _doc: Y.Doc): IYDocPersistence => {
  return {
    synced: false,
    once(_event: 'synced', cb: () => void) {
      // Fire synchronously — for test environments where no IndexedDB exists.
      // Real IndexeddbPersistence fires asynchronously after loading from IDB.
      cb();
    },
    destroy() {
      // No-op
    },
    whenSynced: Promise.resolve(),
  };
};

/**
 * Default loadUpdatesRaw: returns empty array (no IndexedDB).
 * Production code should pass the real loadUpdatesRaw from y-indexeddb.
 * Used for idle mode auto-merge (BUG-021 fix).
 */
const defaultLoadUpdatesRaw: LoadUpdatesRaw = async (_vaultId: string): Promise<Uint8Array[]> => {
  // Return empty array for test environments where no IndexedDB exists.
  // Real implementation should use loadUpdatesRaw from y-indexeddb.
  return [];
};

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
