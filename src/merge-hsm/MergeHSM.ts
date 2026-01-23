/**
 * MergeHSM - Hierarchical State Machine for Document Synchronization
 *
 * Manages the sync between disk, local CRDT (Yjs), and remote CRDT.
 * Pure state machine: events in → state transitions → effects out.
 *
 * Architecture:
 * - Two-YDoc architecture: localDoc (persisted) + remoteDoc (ephemeral)
 * - In active mode: editor ↔ localDoc ↔ remoteDoc ↔ server
 * - In idle mode: lightweight, no YDocs in memory
 */

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
// MergeHSM Implementation
// =============================================================================

/**
 * Extended config for testing that allows initializing to specific states.
 */
export interface TestMergeHSMConfig extends MergeHSMConfig {
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

export class MergeHSM implements TestableHSM {
  // State
  private _state: MergeState;

  // YDocs (only populated in active mode)
  private localDoc: Y.Doc | null = null;
  private remoteDoc: Y.Doc | null = null;

  // Pending disk contents for merge (stored when DISK_CHANGED arrives in active mode)
  private pendingDiskContents: string | null = null;

  // Conflict data (stored when MERGE_CONFLICT is detected)
  private conflictData: { base: string; local: string; remote: string } | null = null;

  // Track previous sync status for change detection
  private lastSyncStatus: SyncStatusType = 'synced';

  // Pending updates for idle mode auto-merge
  private pendingIdleUpdates: Uint8Array | null = null;

  // Last known editor text (for drift detection)
  private lastKnownEditorText: string | null = null;

  // Listeners
  private effectListeners: Array<(effect: MergeEffect) => void> = [];
  private stateChangeListeners: Array<
    (from: StatePath, to: StatePath, event: MergeEvent) => void
  > = [];

  // Configuration
  private timeProvider: TimeProvider;
  private hashFn: (contents: string) => Promise<string>;

  constructor(config: MergeHSMConfig) {
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn ?? defaultHashFn;

    this._state = {
      guid: config.guid,
      path: config.path,
      lca: null,
      disk: null,
      localStateVector: null,
      remoteStateVector: null,
      statePath: 'unloaded',
    };
  }

  /**
   * Create a MergeHSM instance for testing with optional initial state.
   * This bypasses normal state transitions for test setup.
   */
  static forTesting(config: TestMergeHSMConfig): MergeHSM {
    const hsm = new MergeHSM({
      guid: config.guid,
      path: config.path,
      timeProvider: config.timeProvider,
      hashFn: config.hashFn,
    });

    // Set initial state and data
    if (config.initialState) {
      hsm._state.statePath = config.initialState;
    }
    if (config.lca) {
      hsm._state.lca = config.lca;
    }
    if (config.disk) {
      hsm._state.disk = config.disk;
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
  // Public API
  // ===========================================================================

  get state(): MergeState {
    return this._state;
  }

  send(event: MergeEvent): void {
    const fromState = this._state.statePath;
    this.handleEvent(event);
    const toState = this._state.statePath;

    if (fromState !== toState) {
      this.notifyStateChange(fromState, toState, event);
    }
  }

  matches(statePath: string): boolean {
    return (
      this._state.statePath === statePath ||
      this._state.statePath.startsWith(statePath + '.')
    );
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
      guid: this._state.guid,
      path: this._state.path,
      status: this.computeSyncStatusType(),
      diskMtime: this._state.disk?.mtime ?? 0,
      localStateVector: this._state.localStateVector ?? new Uint8Array([0]),
      remoteStateVector: this._state.remoteStateVector ?? new Uint8Array([0]),
    };
  }

  /**
   * Check for drift between editor and localDoc, correcting if needed.
   * Returns true if drift was detected and corrected.
   *
   * Drift detection compares the last known editor text (from CM6_CHANGE)
   * with the current localDoc content. If they differ, localDoc wins
   * and a DISPATCH_CM6 effect is emitted to correct the editor.
   */
  checkAndCorrectDrift(): boolean {
    if (this._state.statePath !== 'active.tracking') {
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
    // Compute changes to bring editor in sync with localDoc
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
   * Compute the positioned changes needed to transform 'from' text into 'to' text.
   */
  private computeDiffChanges(from: string, to: string): PositionedChange[] {
    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(from, to);
    dmp.diff_cleanupSemantic(diffs);

    const changes: PositionedChange[] = [];
    let pos = 0;

    for (const [op, text] of diffs) {
      if (op === 0) {
        // Equal - advance position
        pos += text.length;
      } else if (op === -1) {
        // Delete
        changes.push({ from: pos, to: pos + text.length, insert: '' });
        pos += text.length;
      } else if (op === 1) {
        // Insert
        changes.push({ from: pos, to: pos, insert: text });
        // Don't advance pos - insert doesn't consume source chars
      }
    }

    // Merge consecutive changes at same position for efficiency
    return this.mergeAdjacentChanges(changes);
  }

  /**
   * Merge adjacent changes that can be combined.
   */
  private mergeAdjacentChanges(changes: PositionedChange[]): PositionedChange[] {
    if (changes.length <= 1) return changes;

    const merged: PositionedChange[] = [];
    let current = { ...changes[0] };

    for (let i = 1; i < changes.length; i++) {
      const next = changes[i];
      // Check if changes are adjacent and can be merged
      if (current.to === next.from && current.insert === '') {
        // Delete followed by something at same end position
        current.to = next.to;
        current.insert = next.insert;
      } else if (current.from === next.from && current.to === current.from) {
        // Insert followed by something at same position
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

  /**
   * Compute the sync status type based on current state.
   */
  private computeSyncStatusType(): SyncStatusType {
    const statePath = this._state.statePath;

    // Error states
    if (statePath === 'idle.error' || this._state.error) {
      return 'error';
    }

    // Conflict states
    if (statePath.includes('conflict') || statePath === 'idle.diverged') {
      return 'conflict';
    }

    // Pending/syncing states
    if (
      statePath === 'idle.localAhead' ||
      statePath === 'idle.remoteAhead' ||
      statePath === 'idle.diskAhead' ||
      statePath === 'active.merging'
    ) {
      return 'pending';
    }

    // Clean/synced states
    if (statePath === 'idle.clean' || statePath === 'active.tracking') {
      return 'synced';
    }

    // Loading/transition states - treat as pending
    if (statePath.startsWith('loading.') || statePath === 'unloading') {
      return 'pending';
    }

    // Unloaded - treat as synced (no active sync)
    return 'synced';
  }

  subscribe(listener: (effect: MergeEffect) => void): () => void {
    this.effectListeners.push(listener);
    return () => {
      const index = this.effectListeners.indexOf(listener);
      if (index >= 0) {
        this.effectListeners.splice(index, 1);
      }
    };
  }

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
  // Event Handler (Main State Machine Logic)
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
    this._state.guid = event.guid;
    this._state.path = event.path;
    this.transitionTo('loading.loadingPersistence');
  }

  private handlePersistenceLoaded(event: {
    updates: Uint8Array;
    lca: LCAState | null;
  }): void {
    this._state.lca = event.lca;

    // Store local state vector if updates provided
    if (event.updates.length > 0) {
      this._state.localStateVector = Y.encodeStateVectorFromUpdate(event.updates);
    }

    // Transition through loadingLCA briefly, then determine idle state
    this.transitionTo('loading.loadingLCA');

    // Auto-transition to appropriate idle state based on current knowledge
    // The integration layer will later trigger ACQUIRE_LOCK if editor opens
    this.determineAndTransitionToIdleState();
  }

  /**
   * Determine and transition to the appropriate idle state based on
   * comparison of LCA, local, remote, and disk states.
   */
  private determineAndTransitionToIdleState(): void {
    const lca = this._state.lca;
    const disk = this._state.disk;
    const localSV = this._state.localStateVector;
    const remoteSV = this._state.remoteStateVector;

    // No LCA means we haven't established a sync point yet
    if (!lca) {
      // If we have local updates, we're ahead
      if (localSV && localSV.length > 1) {
        this.transitionTo('idle.localAhead');
        return;
      }
      // Otherwise clean (new doc)
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

  /**
   * Check if local CRDT has changes since LCA.
   */
  private hasLocalChangedSinceLCA(): boolean {
    if (!this._state.lca) return false;
    const lcaSV = this._state.lca.stateVector;
    const localSV = this._state.localStateVector;

    if (!localSV) return false;

    // Compare state vectors - if local is different/ahead, there are changes
    return !this.stateVectorsEqual(lcaSV, localSV);
  }

  /**
   * Check if disk has changes since LCA.
   */
  private hasDiskChangedSinceLCA(): boolean {
    if (!this._state.lca || !this._state.disk) return false;

    // Compare hashes - if different, disk changed
    return this._state.lca.meta.hash !== this._state.disk.hash;
  }

  /**
   * Check if remote CRDT has changes since LCA.
   */
  private hasRemoteChangedSinceLCA(): boolean {
    if (!this._state.lca) return false;
    const lcaSV = this._state.lca.stateVector;
    const remoteSV = this._state.remoteStateVector;

    if (!remoteSV) return false;

    return !this.stateVectorsEqual(lcaSV, remoteSV);
  }

  /**
   * Compare two Yjs state vectors for equality.
   */
  private stateVectorsEqual(sv1: Uint8Array, sv2: Uint8Array): boolean {
    if (sv1.length !== sv2.length) return false;
    for (let i = 0; i < sv1.length; i++) {
      if (sv1[i] !== sv2[i]) return false;
    }
    return true;
  }

  // ===========================================================================
  // Idle Mode Auto-Merge
  // ===========================================================================

  /**
   * Attempt auto-merge in idle mode.
   * Called after transitioning to remoteAhead, diskAhead, or diverged.
   */
  private attemptIdleAutoMerge(): void {
    const state = this._state.statePath;

    if (state === 'idle.remoteAhead') {
      // If disk == lca, we can auto-merge remote changes
      if (!this.hasDiskChangedSinceLCA()) {
        this.performIdleRemoteAutoMerge();
      }
    } else if (state === 'idle.diskAhead') {
      // If remote == lca, we can auto-merge disk changes
      if (!this.hasRemoteChangedSinceLCA()) {
        this.performIdleDiskAutoMerge();
      }
    } else if (state === 'idle.diverged') {
      // Attempt 3-way merge
      this.performIdleThreeWayMerge();
    }
  }

  /**
   * Auto-merge remote changes in idle mode (remote ahead, disk unchanged).
   * Creates temporary YDoc, applies updates, emits WRITE_DISK.
   */
  private performIdleRemoteAutoMerge(): void {
    if (!this.pendingIdleUpdates || !this._state.lca) return;

    // Create temporary doc to extract content from update
    const tempDoc = new Y.Doc();
    try {
      // Apply pending remote updates (contains full state)
      Y.applyUpdate(tempDoc, this.pendingIdleUpdates);

      const mergedContent = tempDoc.getText('content').toString();

      // Emit WRITE_DISK effect
      this.emitEffect({
        type: 'WRITE_DISK',
        path: this._state.path,
        contents: mergedContent,
      });

      // Update LCA
      this._state.lca = {
        contents: mergedContent,
        meta: {
          hash: simpleHash(mergedContent),
          mtime: this.timeProvider.getTime(),
        },
        stateVector: Y.encodeStateVector(tempDoc),
      };

      // Clear pending updates
      this.pendingIdleUpdates = null;

      // Transition to clean
      this.transitionTo('idle.clean');

      // Persist state
      this.emitPersistState();
    } finally {
      tempDoc.destroy();
    }
  }

  /**
   * Auto-merge disk changes in idle mode (disk ahead, remote unchanged).
   * Reads disk content, syncs to remote.
   */
  private performIdleDiskAutoMerge(): void {
    if (!this.pendingDiskContents || !this._state.lca) return;

    // Create temporary doc for sync
    const tempDoc = new Y.Doc();
    try {
      // Apply stored local updates first (if any)
      // Then apply disk content
      tempDoc.getText('content').insert(0, this.pendingDiskContents);

      // Get update to sync to remote
      const update = Y.encodeStateAsUpdate(tempDoc);

      // Emit SYNC_TO_REMOTE effect
      this.emitEffect({ type: 'SYNC_TO_REMOTE', update });

      // Update LCA
      this._state.lca = {
        contents: this.pendingDiskContents,
        meta: {
          hash: this._state.disk?.hash ?? simpleHash(this.pendingDiskContents),
          mtime: this._state.disk?.mtime ?? this.timeProvider.getTime(),
        },
        stateVector: Y.encodeStateVector(tempDoc),
      };

      // Clear pending
      this.pendingDiskContents = null;

      // Transition to clean
      this.transitionTo('idle.clean');

      // Persist state
      this.emitPersistState();
    } finally {
      tempDoc.destroy();
    }
  }

  /**
   * Attempt 3-way merge in idle mode (diverged state).
   */
  private performIdleThreeWayMerge(): void {
    if (!this._state.lca) return;

    const lcaContent = this._state.lca.contents;

    // Get remote content (from stored updates)
    // The updates contain full state, so we just need to extract the text
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

    // Get disk content (this is the "local" side - changes on this machine)
    const diskContent = this.pendingDiskContents ?? lcaContent;

    // Attempt 3-way merge: base=LCA, local=disk, remote=server
    const mergeResult = performThreeWayMerge(lcaContent, diskContent, remoteContent);

    if (mergeResult.success) {
      // Merge succeeded - emit WRITE_DISK
      this.emitEffect({
        type: 'WRITE_DISK',
        path: this._state.path,
        contents: mergeResult.merged,
      });

      // Create temp doc for state vector
      const tempDoc = new Y.Doc();
      try {
        tempDoc.getText('content').insert(0, mergeResult.merged);

        // Update LCA
        this._state.lca = {
          contents: mergeResult.merged,
          meta: {
            hash: simpleHash(mergeResult.merged),
            mtime: this.timeProvider.getTime(),
          },
          stateVector: Y.encodeStateVector(tempDoc),
        };
      } finally {
        tempDoc.destroy();
      }

      // Sync to remote
      const syncDoc = new Y.Doc();
      try {
        syncDoc.getText('content').insert(0, mergeResult.merged);
        const update = Y.encodeStateAsUpdate(syncDoc);
        this.emitEffect({ type: 'SYNC_TO_REMOTE', update });
      } finally {
        syncDoc.destroy();
      }

      // Clear pending
      this.pendingIdleUpdates = null;
      this.pendingDiskContents = null;

      // Transition to clean
      this.transitionTo('idle.clean');

      // Persist state
      this.emitPersistState();
    }
    // If merge failed, stay in diverged - wait for user to open file
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
    if (
      this._state.statePath.startsWith('idle.') ||
      this._state.statePath.startsWith('loading.')
    ) {
      // Create YDocs first
      this.createYDocs();

      // Check if we're coming from diverged state - go to conflict.blocked
      if (this._state.statePath === 'idle.diverged') {
        this.transitionTo('active.conflict.blocked');
        // Immediately show banner (spec: "show banner immediately")
        this.transitionTo('active.conflict.bannerShown');
      } else {
        this.transitionTo('active.entering');
      }
    }
  }

  private handleYDocsReady(): void {
    if (this._state.statePath === 'active.entering') {
      this.transitionTo('active.tracking');
    }
  }

  private handleReleaseLock(): void {
    if (this._state.statePath.startsWith('active.')) {
      this.transitionTo('unloading');
      this.cleanupYDocs();
      this.transitionTo('idle.clean');
    }
  }

  // ===========================================================================
  // YDoc Management
  // ===========================================================================

  private createYDocs(): void {
    this.localDoc = new Y.Doc();
    this.remoteDoc = new Y.Doc();
  }

  private cleanupYDocs(): void {
    if (this.localDoc) {
      this.localDoc.destroy();
      this.localDoc = null;
    }
    if (this.remoteDoc) {
      this.remoteDoc.destroy();
      this.remoteDoc = null;
    }
  }

  /**
   * Initialize localDoc with content.
   * Also syncs to remoteDoc to keep them aligned.
   */
  initializeLocalDoc(content: string): void {
    if (!this.localDoc || !this.remoteDoc) return;

    this.localDoc.getText('content').insert(0, content);
    // Sync remoteDoc FROM localDoc so they share the same state/history
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
    if (this._state.statePath !== 'active.tracking') return;

    // Track the last known editor text for drift detection
    this.lastKnownEditorText = event.docText;

    // If this change came from Yjs, don't re-apply or sync
    if (event.isFromYjs) return;

    // Apply changes to localDoc
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
      }, this); // origin = this to identify local changes
    }

    // Sync localDoc → remoteDoc
    this.syncLocalToRemote();
  }

  private syncLocalToRemote(): void {
    if (!this.localDoc || !this.remoteDoc) return;

    const update = Y.encodeStateAsUpdate(
      this.localDoc,
      Y.encodeStateVector(this.remoteDoc)
    );

    if (update.length > 0) {
      // Apply to remoteDoc
      Y.applyUpdate(this.remoteDoc, update, 'local');

      // Emit effect for provider to send to server
      this.emitEffect({ type: 'SYNC_TO_REMOTE', update });
    }
  }

  // ===========================================================================
  // Active Mode: Remote Updates
  // ===========================================================================

  private handleRemoteUpdate(event: { update: Uint8Array }): void {
    // Apply update to remoteDoc if it exists
    if (this.remoteDoc) {
      Y.applyUpdate(this.remoteDoc, event.update, 'remote');
    }

    // Update remote state vector
    this._state.remoteStateVector = Y.encodeStateVectorFromUpdate(event.update);

    if (this._state.statePath === 'active.tracking') {
      // In active mode, merge remote → local and dispatch to editor
      this.mergeRemoteToLocal();
    } else if (this._state.statePath.startsWith('idle.')) {
      // Store update for potential auto-merge
      if (this.pendingIdleUpdates) {
        this.pendingIdleUpdates = Y.mergeUpdates([this.pendingIdleUpdates, event.update]);
      } else {
        this.pendingIdleUpdates = event.update;
      }

      // Determine appropriate idle state based on disk state
      if (this.hasDiskChangedSinceLCA()) {
        // Disk has also diverged - we have both remote and disk changes
        this.transitionTo('idle.diverged');
      } else {
        // Only remote has changed
        this.transitionTo('idle.remoteAhead');
      }
      this.attemptIdleAutoMerge();
    }
  }

  private handleRemoteDocUpdated(): void {
    if (this._state.statePath === 'active.tracking') {
      this.mergeRemoteToLocal();
    }
  }

  private mergeRemoteToLocal(): void {
    if (!this.localDoc || !this.remoteDoc) return;

    const beforeText = this.localDoc.getText('content').toString();

    // Get update from remote that local doesn't have
    const update = Y.encodeStateAsUpdate(
      this.remoteDoc,
      Y.encodeStateVector(this.localDoc)
    );

    // Apply to localDoc
    Y.applyUpdate(this.localDoc, update, 'remote');

    const afterText = this.localDoc.getText('content').toString();

    // If content changed, dispatch to editor
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
    this._state.disk = {
      hash: event.hash,
      mtime: event.mtime,
    };

    // Store disk contents
    this.pendingDiskContents = event.contents;

    if (this._state.statePath === 'active.tracking') {
      this.transitionTo('active.merging');

      // Perform 3-way merge
      this.performDiskMerge(event.contents);
    } else if (this._state.statePath.startsWith('idle.')) {
      // Determine appropriate idle state
      const remoteChanged = this.hasRemoteChangedSinceLCA();

      if (remoteChanged) {
        this.transitionTo('idle.diverged');
      } else {
        this.transitionTo('idle.diskAhead');
      }

      // Attempt auto-merge
      this.attemptIdleAutoMerge();
    }
  }

  /**
   * Perform 3-way merge between LCA, localDoc, and disk contents.
   * Emits MERGE_SUCCESS or MERGE_CONFLICT based on result.
   */
  private performDiskMerge(diskContents: string): void {
    if (!this.localDoc) return;

    const localText = this.localDoc.getText('content').toString();
    const lcaText = this._state.lca?.contents ?? '';

    // If disk matches local, no merge needed
    if (diskContents === localText) {
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this.createLCAFromCurrent(diskContents),
      });
      return;
    }

    // If disk matches LCA, local has all changes - no merge needed
    if (diskContents === lcaText) {
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this._state.lca!,
      });
      return;
    }

    // If local matches LCA, disk has all changes - apply disk
    if (localText === lcaText) {
      this.applyContentToLocalDoc(diskContents);
      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this.createLCAFromCurrent(diskContents),
      });
      return;
    }

    // Perform actual 3-way merge
    const mergeResult = performThreeWayMerge(lcaText, localText, diskContents);

    if (mergeResult.success) {
      // Apply merged content to localDoc
      this.applyContentToLocalDoc(mergeResult.merged);

      // Emit changes to editor
      if (mergeResult.patches.length > 0) {
        this.emitEffect({ type: 'DISPATCH_CM6', changes: mergeResult.patches });
      }

      this.send({
        type: 'MERGE_SUCCESS',
        newLCA: this.createLCAFromCurrent(mergeResult.merged),
      });
    } else {
      // Conflict - need user resolution
      this.send({
        type: 'MERGE_CONFLICT',
        base: mergeResult.base,
        local: mergeResult.local,
        remote: mergeResult.remote,
      });
    }
  }

  /**
   * Apply new content to localDoc, replacing all existing content.
   */
  private applyContentToLocalDoc(newContent: string): void {
    if (!this.localDoc) return;

    const ytext = this.localDoc.getText('content');
    const currentText = ytext.toString();

    if (currentText === newContent) return;

    this.localDoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, newContent);
    }, this);

    // Sync to remoteDoc
    this.syncLocalToRemote();
  }

  /**
   * Create an LCA state from current content.
   */
  private createLCAFromCurrent(contents: string): LCAState {
    return {
      contents,
      meta: {
        hash: simpleHash(contents),
        mtime: this.timeProvider.getTime(),
      },
      stateVector: this.localDoc
        ? Y.encodeStateVector(this.localDoc)
        : new Uint8Array([0]),
    };
  }

  private handleSaveComplete(event: { mtime: number }): void {
    // Update LCA mtime when Obsidian finishes writing to disk
    if (this._state.lca) {
      this._state.lca = {
        ...this._state.lca,
        meta: {
          ...this._state.lca.meta,
          mtime: event.mtime,
        },
      };

      // Persist updated LCA
      this.emitPersistState();
    }
  }

  // ===========================================================================
  // Conflict Resolution
  // ===========================================================================

  private handleMergeSuccess(event: { newLCA: LCAState }): void {
    if (this._state.statePath === 'active.merging') {
      this._state.lca = event.newLCA;
      this.transitionTo('active.tracking');

      // Persist updated LCA
      this.emitPersistState();
    }
  }

  private handleMergeConflict(event: {
    base: string;
    local: string;
    remote: string;
  }): void {
    if (this._state.statePath === 'active.merging') {
      // Store conflict data for resolution
      this.conflictData = {
        base: event.base,
        local: event.local,
        remote: event.remote,
      };
      this.transitionTo('active.conflict.bannerShown');
    }
  }

  private handleOpenDiffView(): void {
    if (this._state.statePath === 'active.conflict.bannerShown') {
      this.transitionTo('active.conflict.resolving');
    }
  }

  private handleCancel(): void {
    // CANCEL closes the diff view and returns to banner
    if (this._state.statePath === 'active.conflict.resolving') {
      this.transitionTo('active.conflict.bannerShown');
    }
  }

  private handleResolve(event: MergeEvent): void {
    if (this._state.statePath === 'active.conflict.resolving') {
      switch (event.type) {
        case 'RESOLVE_ACCEPT_DISK':
          // Apply disk (remote) content to localDoc
          if (this.conflictData) {
            const beforeText = this.localDoc?.getText('content').toString() ?? '';
            this.applyContentToLocalDoc(this.conflictData.remote);

            // Emit changes to editor
            const diskChanges = computePositionedChanges(
              beforeText,
              this.conflictData.remote
            );
            if (diskChanges.length > 0) {
              this.emitEffect({ type: 'DISPATCH_CM6', changes: diskChanges });
            }

            // Update LCA to new agreed state
            this._state.lca = this.createLCAFromCurrent(this.conflictData.remote);
          }
          break;

        case 'RESOLVE_ACCEPT_LOCAL':
          // Keep localDoc as-is - disk will sync on next save
          // Just update LCA to current local content
          if (this.localDoc) {
            const localText = this.localDoc.getText('content').toString();
            this._state.lca = this.createLCAFromCurrent(localText);
          }
          break;

        case 'RESOLVE_ACCEPT_MERGED':
          // Apply user-edited merged content
          if ('contents' in event) {
            const beforeText = this.localDoc?.getText('content').toString() ?? '';
            this.applyContentToLocalDoc(event.contents);

            // Emit changes to editor
            const mergedChanges = computePositionedChanges(beforeText, event.contents);
            if (mergedChanges.length > 0) {
              this.emitEffect({ type: 'DISPATCH_CM6', changes: mergedChanges });
            }

            // Update LCA
            this._state.lca = this.createLCAFromCurrent(event.contents);
          }
          break;
      }

      // Clear conflict data
      this.conflictData = null;
      this.pendingDiskContents = null;

      this.transitionTo('active.tracking');
    }
  }

  private handleDismissConflict(): void {
    if (this._state.statePath === 'active.conflict.bannerShown') {
      // Store hashes to avoid re-showing this conflict
      this._state.deferredConflict = {
        diskHash: this._state.disk?.hash ?? '',
        localHash: this.computeLocalHash(),
      };
      this.transitionTo('active.tracking');

      // Persist deferred conflict info
      this.emitPersistState();
    }
  }

  private computeLocalHash(): string {
    if (!this.localDoc) return '';
    const text = this.localDoc.getText('content').toString();
    return simpleHash(text);
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
    this._state.error = event.error;
    if (this._state.statePath.startsWith('idle.')) {
      this.transitionTo('idle.error');
    }
  }

  // ===========================================================================
  // State Transition Helper
  // ===========================================================================

  private transitionTo(newState: StatePath): void {
    const oldStatus = this.lastSyncStatus;
    this._state = { ...this._state, statePath: newState };
    const newStatus = this.computeSyncStatusType();

    // Emit STATUS_CHANGED if sync status changed
    if (oldStatus !== newStatus) {
      this.lastSyncStatus = newStatus;
      this.emitEffect({
        type: 'STATUS_CHANGED',
        guid: this._state.guid,
        status: this.getSyncStatus(),
      });
    }
  }

  // ===========================================================================
  // Effect Emission
  // ===========================================================================

  private emitEffect(effect: MergeEffect): void {
    for (const listener of this.effectListeners) {
      listener(effect);
    }
  }

  /**
   * Emit PERSIST_STATE effect to save current HSM state.
   */
  private emitPersistState(): void {
    const persistedState: PersistedMergeState = {
      guid: this._state.guid,
      path: this._state.path,
      lca: this._state.lca
        ? {
            contents: this._state.lca.contents,
            hash: this._state.lca.meta.hash,
            mtime: this._state.lca.meta.mtime,
            stateVector: this._state.lca.stateVector,
          }
        : null,
      disk: this._state.disk,
      localStateVector: this._state.localStateVector,
      lastStatePath: this._state.statePath,
      deferredConflict: this._state.deferredConflict,
      persistedAt: this.timeProvider.getTime(),
    };

    this.emitEffect({
      type: 'PERSIST_STATE',
      guid: this._state.guid,
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
    for (const listener of this.stateChangeListeners) {
      listener(from, to, event);
    }
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Compute positioned changes between two strings.
 * Used to convert Yjs deltas to CM6 changes.
 */
function computePositionedChanges(
  before: string,
  after: string
): PositionedChange[] {
  // Find common prefix
  let prefixLen = 0;
  while (
    prefixLen < before.length &&
    prefixLen < after.length &&
    before[prefixLen] === after[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix
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

/**
 * Simple synchronous hash for testing.
 * Production should use SHA-256 via SubtleCrypto.
 */
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
 * Default async hash function using SubtleCrypto.
 */
async function defaultHashFn(contents: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(contents);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback to simple hash
  return simpleHash(contents);
}

// =============================================================================
// 3-Way Merge Implementation
// =============================================================================

/**
 * Perform a 3-way merge using node-diff3.
 *
 * @param lca - The Last Common Ancestor (base) content
 * @param local - The local (current) content
 * @param remote - The remote (incoming) content (disk in our case)
 * @returns MergeResult with success/failure and patches or conflict info
 */
function performThreeWayMerge(
  lca: string,
  local: string,
  remote: string
): MergeResult {
  // Split into lines for diff3
  const lcaLines = lca.split('\n');
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');

  // Perform 3-way merge (node-diff3 uses: a=local, o=original, b=remote)
  const result = diff3Merge(localLines, lcaLines, remoteLines);

  // Check if there are any conflicts
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

  // No conflicts - build merged result
  const mergedLines: string[] = [];
  for (const region of result) {
    if ('ok' in region && region.ok) {
      mergedLines.push(...region.ok);
    }
  }
  const merged = mergedLines.join('\n');

  // Compute character-level changes from local to merged using diff-match-patch
  const patches = computeDiffMatchPatchChanges(local, merged);

  return {
    success: true,
    merged,
    patches,
  };
}

/**
 * Extract conflict regions from diff3 result.
 */
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

/**
 * Compute character-level positioned changes using diff-match-patch.
 */
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
      // Equal - advance position
      pos += text.length;
    } else if (op === -1) {
      // Delete
      changes.push({ from: pos, to: pos + text.length, insert: '' });
      pos += text.length;
    } else if (op === 1) {
      // Insert
      changes.push({ from: pos, to: pos, insert: text });
      // Don't advance pos for inserts (they're at current position)
    }
  }

  // Merge adjacent changes for efficiency
  return mergeAdjacentChanges(changes);
}

/**
 * Merge adjacent delete+insert into single replacement changes.
 */
function mergeAdjacentChanges(changes: PositionedChange[]): PositionedChange[] {
  if (changes.length <= 1) return changes;

  const merged: PositionedChange[] = [];
  let i = 0;

  while (i < changes.length) {
    const current = changes[i];

    // Look for delete followed by insert at same position
    if (
      i + 1 < changes.length &&
      current.insert === '' &&
      changes[i + 1].from === current.from &&
      changes[i + 1].to === changes[i + 1].from
    ) {
      // Merge delete + insert into single replacement
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
