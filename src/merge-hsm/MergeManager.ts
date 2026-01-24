/**
 * MergeManager - Manages Multiple MergeHSM Instances
 *
 * Provides centralized management for all document HSMs:
 * - Tracks sync status for all registered documents
 * - Handles idle mode remote updates without loading full YDocs
 * - Manages HSM lifecycle (load/unload)
 * - Persists index state
 */

import * as Y from 'yjs';
import { MergeHSM } from './MergeHSM';
import type {
  SyncStatus,
  MergeEffect,
  PersistedMergeState,
} from './types';
import type { TimeProvider } from '../TimeProvider';
import { DefaultTimeProvider } from '../TimeProvider';
import { ObservableMap } from '../observable/ObservableMap';

// =============================================================================
// Types
// =============================================================================

export interface MergeManagerConfig {
  /**
   * Function to generate vault ID for a document.
   * Convention: `${appId}-relay-doc-${guid}`
   */
  getVaultId: (guid: string) => string;

  /** Time provider (for testing) */
  timeProvider?: TimeProvider;

  /** Hash function */
  hashFn?: (contents: string) => Promise<string>;

  /** Callback to load persisted state for a document */
  loadState?: (guid: string) => Promise<PersistedMergeState | null>;

  /** Callback to load persisted updates for a document */
  loadUpdates?: (guid: string) => Promise<Uint8Array | null>;

  /** Callback when an effect is emitted by any HSM */
  onEffect?: (guid: string, effect: MergeEffect) => void;

  /**
   * Callback to get disk state for a document (for polling).
   * Returns { contents, mtime, hash } or null if file doesn't exist.
   */
  getDiskState?: (path: string) => Promise<{
    contents: string;
    mtime: number;
    hash: string;
  } | null>;

  /**
   * Callback to persist the sync status index.
   */
  persistIndex?: (status: Map<string, SyncStatus>) => Promise<void>;
}

export interface PollOptions {
  /** Only poll specific GUIDs */
  guids?: string[];
}

export interface RegisteredDocument {
  guid: string;
  path: string;
  syncStatus: SyncStatus;
}

// =============================================================================
// MergeManager Implementation
// =============================================================================

export class MergeManager {
  // Sync status for ALL registered documents (loaded or not) - Observable per spec
  private readonly _syncStatus = new ObservableMap<string, SyncStatus>('MergeManager.syncStatus');

  // Loaded HSM instances (only for documents with editor open)
  private loadedHSMs: Map<string, MergeHSM> = new Map();

  // Registered documents (guid → path mapping)
  private registeredDocs: Map<string, string> = new Map();

  // Stored updates for idle mode (guid → merged updates)
  private idleUpdates: Map<string, Uint8Array> = new Map();

  // Configuration
  private getVaultId: (guid: string) => string;
  private timeProvider: TimeProvider;
  private hashFn?: (contents: string) => Promise<string>;
  private loadState?: (guid: string) => Promise<PersistedMergeState | null>;
  private loadUpdates?: (guid: string) => Promise<Uint8Array | null>;
  private onEffect?: (guid: string, effect: MergeEffect) => void;
  private getDiskState?: (path: string) => Promise<{
    contents: string;
    mtime: number;
    hash: string;
  } | null>;
  private _persistIndex?: (status: Map<string, SyncStatus>) => Promise<void>;

  constructor(config: MergeManagerConfig) {
    this.getVaultId = config.getVaultId;
    this.timeProvider = config.timeProvider ?? new DefaultTimeProvider();
    this.hashFn = config.hashFn;
    this.loadState = config.loadState;
    this.loadUpdates = config.loadUpdates;
    this.onEffect = config.onEffect;
    this.getDiskState = config.getDiskState;
    this._persistIndex = config.persistIndex;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get sync status for all registered documents (ObservableMap per spec).
   */
  get syncStatus(): ObservableMap<string, SyncStatus> {
    return this._syncStatus;
  }

  /**
   * Get or create an HSM for a document, loading it into active mode.
   * @param guid - Document GUID
   * @param path - Virtual path within shared folder
   * @param remoteDoc - Remote YDoc, managed externally with provider attached
   */
  async getHSM(guid: string, path: string, remoteDoc: Y.Doc): Promise<MergeHSM> {
    // Return existing HSM if loaded
    const existing = this.loadedHSMs.get(guid);
    if (existing) {
      return existing;
    }

    // Create new HSM
    const hsm = new MergeHSM({
      guid,
      path,
      vaultId: this.getVaultId(guid),
      remoteDoc,
      timeProvider: this.timeProvider,
      hashFn: this.hashFn,
    });

    // Subscribe to effects
    hsm.subscribe((effect) => {
      this.handleHSMEffect(guid, effect);
    });

    // Subscribe to state changes to update sync status
    hsm.onStateChange(() => {
      this.updateSyncStatus(guid, hsm.getSyncStatus());
    });

    // Load persisted state if available
    if (this.loadState) {
      const persistedState = await this.loadState(guid);
      if (persistedState) {
        // Send LOAD and PERSISTENCE_LOADED events
        hsm.send({ type: 'LOAD', guid, path });

        const updates = this.idleUpdates.get(guid) ?? new Uint8Array();
        hsm.send({
          type: 'PERSISTENCE_LOADED',
          updates,
          lca: persistedState.lca
            ? {
                contents: persistedState.lca.contents,
                meta: {
                  hash: persistedState.lca.hash,
                  mtime: persistedState.lca.mtime,
                },
                stateVector: persistedState.lca.stateVector,
              }
            : null,
        });
      }
    }

    // Store HSM
    this.loadedHSMs.set(guid, hsm);
    this.registeredDocs.set(guid, path);

    // Update sync status
    this.updateSyncStatus(guid, hsm.getSyncStatus());

    return hsm;
  }

  /**
   * Check if an HSM is currently loaded (active mode).
   */
  isLoaded(guid: string): boolean {
    return this.loadedHSMs.has(guid);
  }

  /**
   * Unload an HSM, persisting state and freeing memory.
   */
  async unload(guid: string): Promise<void> {
    const hsm = this.loadedHSMs.get(guid);
    if (!hsm) return;

    // Send RELEASE_LOCK to transition to idle
    hsm.send({ type: 'RELEASE_LOCK' });

    // Send UNLOAD
    hsm.send({ type: 'UNLOAD' });

    // Remove from loaded HSMs
    this.loadedHSMs.delete(guid);

    // Keep sync status (document is still registered)
  }

  /**
   * Register a document without loading its HSM.
   * Used to track documents in idle mode.
   * Fetches actual disk mtime if getDiskState is configured.
   */
  async register(guid: string, path: string): Promise<void> {
    this.registeredDocs.set(guid, path);

    // Initialize sync status if not exists
    if (!this._syncStatus.has(guid)) {
      // Get actual disk state for mtime (if callback is configured)
      let diskMtime = 0;
      if (this.getDiskState) {
        try {
          const diskState = await this.getDiskState(path);
          if (diskState) {
            diskMtime = diskState.mtime;
          }
        } catch (e) {
          // Failed to get disk state - use 0 as fallback
          // This can happen if file doesn't exist yet
        }
      }

      this._syncStatus.set(guid, {
        guid,
        path,
        status: 'synced',
        diskMtime,
        localStateVector: new Uint8Array([0]),
        remoteStateVector: new Uint8Array([0]),
      });
    }
  }

  /**
   * Unregister a document completely.
   */
  unregister(guid: string): void {
    this.registeredDocs.delete(guid);
    this._syncStatus.delete(guid);
    this.idleUpdates.delete(guid);

    // Unload HSM if loaded
    if (this.loadedHSMs.has(guid)) {
      this.unload(guid);
    }
  }

  /**
   * Handle a remote update for a document in idle mode.
   * Merges with stored updates without loading full YDocs.
   */
  async handleIdleRemoteUpdate(guid: string, update: Uint8Array): Promise<void> {
    // If HSM is loaded, forward to it
    const hsm = this.loadedHSMs.get(guid);
    if (hsm) {
      hsm.send({ type: 'REMOTE_UPDATE', update });
      return;
    }

    // Idle mode: merge updates without loading doc
    const existingUpdates = this.idleUpdates.get(guid);

    if (existingUpdates) {
      // Merge updates
      const merged = Y.mergeUpdates([existingUpdates, update]);
      this.idleUpdates.set(guid, merged);
    } else {
      this.idleUpdates.set(guid, update);
    }

    // Update sync status to remoteAhead
    const path = this.registeredDocs.get(guid) ?? '';
    const currentStatus = this._syncStatus.get(guid);

    if (currentStatus) {
      const newStatus: SyncStatus = {
        ...currentStatus,
        status: 'pending',
        remoteStateVector: Y.encodeStateVectorFromUpdate(
          this.idleUpdates.get(guid)!
        ),
      };
      this.updateSyncStatus(guid, newStatus);
    }
  }

  /**
   * Poll for disk changes on registered documents.
   */
  async pollAll(options?: PollOptions): Promise<void> {
    if (!this.getDiskState) {
      return; // No disk state provider configured
    }

    const guids = options?.guids ?? Array.from(this.registeredDocs.keys());

    for (const guid of guids) {
      const hsm = this.loadedHSMs.get(guid);
      if (hsm) {
        // For loaded HSMs, poll via the HSM
        const path = this.registeredDocs.get(guid);
        if (path) {
          const diskState = await this.getDiskState(path);
          if (diskState) {
            hsm.send({
              type: 'DISK_CHANGED',
              contents: diskState.contents,
              mtime: diskState.mtime,
              hash: diskState.hash,
            });
          }
        }
        continue;
      }

      // For idle documents, check if disk has changed since last known state
      const path = this.registeredDocs.get(guid);
      if (path) {
        const diskState = await this.getDiskState(path);
        if (diskState) {
          const currentStatus = this._syncStatus.get(guid);
          if (currentStatus && diskState.mtime !== currentStatus.diskMtime) {
            // Disk has changed - update status to indicate pending sync
            this.updateSyncStatus(guid, {
              ...currentStatus,
              status: 'pending',
              diskMtime: diskState.mtime,
            });
          }
        }
      }
    }
  }

  /**
   * Persist the sync status index.
   */
  async persistIndex(): Promise<void> {
    if (!this._persistIndex) {
      return; // No persistence provider configured
    }

    // Convert ObservableMap to regular Map for persistence
    const statusMap = new Map<string, SyncStatus>();
    for (const [guid, status] of this._syncStatus.entries()) {
      statusMap.set(guid, status);
    }

    await this._persistIndex(statusMap);
  }

  /**
   * Subscribe to sync status changes.
   * @deprecated Use syncStatus.subscribe() directly for ObservableMap subscription.
   */
  onStatusChange(
    listener: (guid: string, status: SyncStatus) => void
  ): () => void {
    // Wrap the listener to work with ObservableMap subscription
    const observableListener = () => {
      // This gets called when any status changes - caller can check what changed
      for (const [guid, status] of this._syncStatus.entries()) {
        listener(guid, status);
      }
    };
    return this._syncStatus.subscribe(observableListener);
  }

  /**
   * Get all registered document GUIDs.
   */
  getRegisteredGuids(): string[] {
    return Array.from(this.registeredDocs.keys());
  }

  /**
   * Get the path for a registered document.
   */
  getPath(guid: string): string | undefined {
    return this.registeredDocs.get(guid);
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  /**
   * Handle an effect emitted by an HSM.
   */
  private handleHSMEffect(guid: string, effect: MergeEffect): void {
    // Forward to external handler
    if (this.onEffect) {
      this.onEffect(guid, effect);
    }

    // Handle specific effects
    switch (effect.type) {
      case 'STATUS_CHANGED':
        this.updateSyncStatus(guid, effect.status);
        break;

      case 'PERSIST_STATE':
        // Integration layer handles actual persistence
        break;

      case 'PERSIST_UPDATES':
        // Store updates for idle mode
        this.idleUpdates.set(guid, effect.update);
        break;
    }
  }

  /**
   * Update sync status.
   * ObservableMap automatically notifies subscribers when set() is called.
   */
  private updateSyncStatus(guid: string, status: SyncStatus): void {
    this._syncStatus.set(guid, status);
  }
}
