import * as Y from 'yjs';
import type { ManagedFile } from './types';
import type { TimeProvider } from '../TimeProvider';
import { metrics } from '../debug';
import type { MergeManagerDocument } from './MergeManager';

export type HibernationState = 'hibernated' | 'working' | 'cached' | 'active';

function emptyHibernationStateCounts(): Record<HibernationState, number> {
  return {
    hibernated: 0,
    working: 0,
    cached: 0,
    active: 0,
  };
}

/** Wake priority levels (lower number = higher priority) */
export enum WakePriority {
  /** P1: Editor opened — immediate, blocking */
  OPEN_DOC = 1,
  /** P2: External file change detected */
  DISK_EDIT = 2,
  /** P3: Inbound CBOR remote update */
  REMOTE_UPDATE = 3,
  /** P4: Background cache validation sweep */
  CACHE_VALIDATION = 4,
}

export interface WakeRequest {
  guid: string;
  priority: WakePriority;
  /** Raw update bytes to buffer (for P3 wake from remote update) */
  update?: Uint8Array;
  /** Signal that the document should connect its provider after waking (for fork reconciliation) */
  connect?: boolean;
}

export interface ResidencyPoolPorts {
  timeProvider: TimeProvider;
  /** Metrics dimension. */
  folderGuid: string;
  /** The document port; the pool never reaches past it. */
  getDocument(guid: string): MergeManagerDocument | undefined;
  /** Owner lifecycle flags, read at decision points. */
  isDestroyed(): boolean;
  isShuttingDown(): boolean;
  hibernateTimeoutMs: number;
  maxConcurrentWarm: number;
}

/**
 * The folder's memory-residency pool: one owner for every slot's
 * hibernation state, buffered remote updates, idle timers, warm LRU,
 * leases, and the bounded wake queue — for documents and managed files
 * alike. The pool reaches targets only through the document port and the
 * ManagedFile contract; validation, caches, and effect routing stay with
 * the merge manager.
 */
export class ResidencyPool {
  /** Memory state per file: hibernated (no YDocs), warm (loaded), active (editor open) */
  private _hibernationState = new Map<string, HibernationState>();

  /** Buffered raw update bytes for hibernated files. Compacted via Y.mergeUpdates. */
  private _hibernationBuffer = new Map<string, Uint8Array>();

  /** Hibernate timers: guid → timer ID. When timer fires, warm → hibernated. */
  private _hibernateTimers = new Map<string, number>();

  /** Wake queue: sorted by priority (lower = higher priority). */
  private _wakeQueue: WakeRequest[] = [];

  /** Currently waking files (bounded concurrency). */
  private _wakingDocs = new Set<string>();

  /**
   * LRU cache of warm file GUIDs. Insertion order = access order
   * (least recently used first). Capacity bounded by maxConcurrentWarm.
   * When full, the oldest entry is evicted (hibernated) to make room.
   */
  private _warmLRU = new Map<string, number>();

  /**
   * Warm-lease holders: guid → per-acquisition tokens. While a lease is
   * held, hibernate() and evictLRU() defer exactly like an in-flight
   * invoke — the pipeline's working set cannot be destroyed beneath a
   * running upload/download by the warm timer or wake-queue pressure.
   * Holder tokens (not a bare count) make a release handle strictly
   * scoped to its own acquisition: a stale handle surviving forget()/
   * re-track churn cannot strip a successor operation's lease.
   */
  private _warmLeases = new Map<string, Set<symbol>>();

  /** Whether the wake queue processor is currently running. */
  private _isProcessingWakeQueue = false;

  /** GUIDs with editor open (lock acquired). */
  private activeDocs: Set<string> = new Set();

  /**
   * Non-document files (canvases today) sharing the residency substrate:
   * same warm budget, timers, LRU, leases, and buffers as documents.
   */
  private _managedFiles = new Map<string, ManagedFile>();

  constructor(private ports: ResidencyPoolPorts) {}

  // =========================================================================
  // State reads
  // =========================================================================

  /** Returns 'hibernated' for unknown files. */
  getState(guid: string): HibernationState {
    return this._hibernationState.get(guid) ?? 'hibernated';
  }

  isLoaded(state: HibernationState): boolean {
    return state === 'working' || state === 'cached' || state === 'active';
  }

  isActive(guid: string): boolean {
    return this.activeDocs.has(guid);
  }

  getBuffer(guid: string): Uint8Array | null {
    return this._hibernationBuffer.get(guid) ?? null;
  }

  getManagedFile(guid: string): ManagedFile | undefined {
    return this._managedFiles.get(guid);
  }

  managedFiles(): Iterable<ManagedFile> {
    return this._managedFiles.values();
  }

  getWakeQueueStats(): { used: number; pending: number; total: number } {
    let warmCount = 0;
    for (const [, state] of this._hibernationState) {
      if (state === 'working') warmCount++;
    }
    return {
      used: warmCount + this._wakingDocs.size,
      pending: this._wakeQueue.length,
      total: this.ports.maxConcurrentWarm,
    };
  }

  getHibernationStateCounts(): Record<HibernationState, number> {
    const counts = emptyHibernationStateCounts();
    for (const state of this._hibernationState.values()) {
      counts[state]++;
    }
    return counts;
  }

  // =========================================================================
  // Wake
  // =========================================================================

  enqueueWake(request: WakeRequest): void {
    if (this.ports.isDestroyed()) return;

    const currentState = this.getState(request.guid);

    // Buffer remote update bytes for hibernated files
    if (request.update) {
      this.bufferUpdate(request.guid, request.update);
    }

    // Already active or warm — just reset the hibernate timer
    if (this.isLoaded(currentState)) {
      this.resetHibernateTimer(request.guid);
      return;
    }

    // Already in the wake queue — update priority if higher
    const existingIdx = this._wakeQueue.findIndex(r => r.guid === request.guid);
    if (existingIdx >= 0) {
      if (request.priority < this._wakeQueue[existingIdx].priority) {
        this._wakeQueue[existingIdx].priority = request.priority;
        this.sortWakeQueue();
      }
      return;
    }

    // Already waking — nothing to do
    if (this._wakingDocs.has(request.guid)) {
      return;
    }

    this._wakeQueue.push(request);
    this.sortWakeQueue();
    this.updateMetrics();
    this.processWakeQueue();
  }

  /**
   * Synchronously wake a hibernated document (for P1 open-doc priority).
   * Drains the hibernation buffer into the HSM immediately. Does NOT
   * connect a provider — the caller handles that.
   *
   * With `{ lease: true }` the wake also takes a warm lease and returns
   * its release handle: until released, hibernate() and LRU eviction
   * defer, so a background operation's localDoc cannot be destroyed
   * mid-pipeline. The lease is acquired before any early return so the
   * handle exists even for a destroyed pool — callers release
   * unconditionally.
   */
  wake(guid: string, remoteDoc: Y.Doc): void;
  wake(guid: string, remoteDoc: Y.Doc, options: { lease: true }): () => void;
  wake(
    guid: string,
    remoteDoc: Y.Doc,
    options?: { lease: true },
  ): (() => void) | void {
    const lease = options?.lease ? this.retain(guid) : undefined;
    if (this.ports.isDestroyed()) return lease;

    const doc = this.ports.getDocument(guid);
    const hsm = doc?.hsm;
    if (!hsm) return lease;
    const currentState = this.getState(guid);
    if (currentState === 'active') return lease;

    // Recreate localDoc destroyed during hibernation
    hsm.ensureLocalDocForIdle();

    // Attach remoteDoc to HSM
    hsm.setRemoteDoc(remoteDoc);

    // Drain buffered updates into the HSM
    const buffered = this._hibernationBuffer.get(guid);
    if (buffered) {
      hsm.send({ type: 'REMOTE_UPDATE', update: buffered });
      this._hibernationBuffer.delete(guid);
    }

    // Remove from wake queue if present
    this._wakeQueue = this._wakeQueue.filter(r => r.guid !== guid);

    if (currentState === 'hibernated') {
      this._hibernationState.set(guid, 'cached');
    }
    this.resetHibernateTimer(guid);
    this.updateMetrics();
    return lease;
  }

  /**
   * Hold the file resident. Concurrent retains are tracked as individual
   * holder tokens; returns an idempotent release scoped to this
   * acquisition. The last release restarts the normal hibernate countdown
   * so the file re-hibernates like any other warm file.
   */
  retain(guid: string): () => void {
    if (this.ports.isDestroyed()) return () => {};
    const holder = Symbol('warmLease');
    let holders = this._warmLeases.get(guid);
    if (!holders) {
      holders = new Set();
      this._warmLeases.set(guid, holders);
    }
    holders.add(holder);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.ports.isDestroyed()) return;
      const current = this._warmLeases.get(guid);
      // Identity guard: after forget() and a re-track, the guid's entry
      // holds successor acquisitions. This handle's token can only be in
      // the set it was acquired into, so a stale handle is a no-op here.
      if (!current || !current.has(holder)) return;
      current.delete(holder);
      if (current.size > 0) return;
      this._warmLeases.delete(guid);
      const state = this.getState(guid);
      if (state === 'working' || state === 'cached') {
        this.resetHibernateTimer(guid);
      }
    };
  }

  /**
   * Synchronously wake a managed file (the P1 analog of wake()): build
   * the working form and drain buffered remote updates.
   */
  wakeManagedFile(guid: string): void {
    const managed = this._managedFiles.get(guid);
    if (!managed || this.ports.isDestroyed() || managed.destroyed) return;
    managed.wake();
    const buffered = this._hibernationBuffer.get(guid);
    if (buffered) {
      this._hibernationBuffer.delete(guid);
      managed.applyRemoteUpdate(buffered);
    }
    this._wakeQueue = this._wakeQueue.filter(r => r.guid !== guid);
    if (this.getState(guid) === 'hibernated') {
      this._hibernationState.set(guid, 'cached');
    }
    this.touchWarmLRU(guid);
    this.resetHibernateTimer(guid);
    this.updateMetrics();
  }

  /**
   * A managed file materialized lazily (any content access wakes it).
   * Account the warm slot, deliver updates buffered while it hibernated,
   * and bound the pool. Without the drain, a pending wake request would
   * later be skipped as already-warm and the buffered bytes lost until an
   * unrelated event.
   */
  notifyManagedFileWarm(guid: string): void {
    if (this.ports.isDestroyed() || !this._managedFiles.has(guid)) return;
    if (this.getState(guid) === 'hibernated') {
      this._hibernationState.set(guid, 'cached');
    }
    const managed = this._managedFiles.get(guid);
    const buffered = this._hibernationBuffer.get(guid);
    if (managed && !managed.destroyed && buffered) {
      this._hibernationBuffer.delete(guid);
      managed.applyRemoteUpdate(buffered);
    }
    this._wakeQueue = this._wakeQueue.filter(r => r.guid !== guid);
    this.touchWarmLRU(guid);
    this.resetHibernateTimer(guid);
    let warmCount = 0;
    for (const [, state] of this._hibernationState) {
      if (state === 'working' || state === 'cached') warmCount++;
    }
    if (warmCount > this.ports.maxConcurrentWarm) {
      this.evictLRU();
    }
    this.updateMetrics();
  }

  // =========================================================================
  // Hibernate
  // =========================================================================

  /**
   * Hibernate a warm file: detach remoteDoc, clear timer. The HSM stays
   * alive with cached state vectors — no YDocs in memory. Leases, managed
   * refusals, and in-flight invokes defer instead.
   */
  hibernate(guid: string): void {
    if (this.ports.isDestroyed()) return;

    const currentState = this.getState(guid);
    if (currentState === 'hibernated') return;
    if (currentState === 'active') return; // Never hibernate active docs

    // A leased doc has a background operation in flight. Defer like a
    // running invoke: reschedule instead of destroying the localDoc the
    // operation is reading.
    if (this._warmLeases.has(guid)) {
      this.resetHibernateTimer(guid);
      return;
    }

    const managed = this._managedFiles.get(guid);
    if (managed) {
      // The file owns its eligibility (in-flight work, held lock,
      // unsettled machine) — a refusal defers like a running invoke.
      if (!managed.tryHibernate()) {
        this.resetHibernateTimer(guid);
        return;
      }
      this.clearHibernateTimer(guid);
      this.removeFromWarmLRU(guid);
      this._hibernationState.set(guid, 'hibernated');
      this.updateMetrics();
      this.processWakeQueue();
      return;
    }

    const doc = this.ports.getDocument(guid);
    // The document owns its teardown (idle-integration release, machine
    // detach); a refusal — an in-flight invoke — defers like a lease.
    if (doc && !doc.tryHibernate()) {
      this.resetHibernateTimer(guid);
      return;
    }

    this.clearHibernateTimer(guid);
    this.removeFromWarmLRU(guid);
    this._hibernationState.set(guid, 'hibernated');
    this.updateMetrics();
    this.processWakeQueue();
  }

  // =========================================================================
  // Slot transitions
  // =========================================================================

  /** Editor lock acquired: pin the slot out of timers and the LRU. */
  markActive(guid: string): void {
    this.activeDocs.add(guid);
    this._hibernationState.set(guid, 'active');
    this.clearHibernateTimer(guid);
    this.removeFromWarmLRU(guid);
    this.updateMetrics();
  }

  /** The editor session ended at RELEASE_LOCK; the slot is no longer pinned. */
  releaseActive(guid: string): void {
    this.activeDocs.delete(guid);
  }

  /** Post-unload settle: warm, countdown running. */
  markCached(guid: string): void {
    this._hibernationState.set(guid, 'cached');
    this.touchWarmLRU(guid);
    this.resetHibernateTimer(guid);
    this.updateMetrics();
  }

  /** Cold registration (cold start, cold managed file). */
  markCold(guid: string): void {
    this._hibernationState.set(guid, 'hibernated');
  }

  /** A non-cold HSM was created: warm slot with the countdown armed. */
  notifyHSMCreated(guid: string): void {
    if (this.ports.isDestroyed()) return;
    if (this._hibernationState.get(guid) === 'hibernated') {
      this.updateMetrics();
      return;
    }
    this._hibernationState.set(guid, 'cached');
    this.resetHibernateTimer(guid);
    this.updateMetrics();
  }

  /** A warm slot was touched by delivered work: refresh LRU and countdown. */
  touchWarm(guid: string): void {
    this.touchWarmLRU(guid);
    this.resetHibernateTimer(guid);
  }

  /**
   * Register a non-document file with the residency substrate. Cold
   * registrations start hibernated; warm ones enter the pool and start
   * the hibernate countdown like any other warm file.
   */
  registerManagedFile(file: ManagedFile): void {
    if (this.ports.isDestroyed() || this._managedFiles.has(file.guid)) return;
    this._managedFiles.set(file.guid, file);
    if (file.isWarm()) {
      this._hibernationState.set(file.guid, 'cached');
      this.touchWarmLRU(file.guid);
      this.resetHibernateTimer(file.guid);
    } else {
      this._hibernationState.set(file.guid, 'hibernated');
    }
    this.updateMetrics();
  }

  /** Returns whether the guid was registered. */
  unregisterManagedFile(guid: string): boolean {
    return this._managedFiles.delete(guid);
  }

  /**
   * Drop every residency trace of a guid in one synchronous pass — the
   * residency half of the owner's stopTracking/unregister teardown. The
   * lease identity guard depends on this deleting `_warmLeases` entries:
   * a stale release handle must find its token gone.
   */
  forget(guid: string): void {
    this._warmLeases.delete(guid);
    this._hibernationState.delete(guid);
    this._hibernationBuffer.delete(guid);
    this.clearHibernateTimer(guid);
    this.removeFromWarmLRU(guid);
    this.activeDocs.delete(guid);
    this.updateMetrics();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Clear all timers and ask managed files to hibernate (shutdown intent). */
  shutdown(): void {
    for (const [guid] of this._hibernateTimers) {
      this.clearHibernateTimer(guid);
    }
    // Managed files close their own IDB connections on hibernate;
    // refusals (held locks) are torn down by their owners' destroy paths.
    for (const managed of this._managedFiles.values()) {
      if (!managed.destroyed) {
        managed.tryHibernate();
      }
    }
  }

  destroy(): void {
    for (const [guid] of this._hibernateTimers) {
      this.clearHibernateTimer(guid);
    }
    this.activeDocs.clear();
    this._hibernationState.clear();
    this._hibernationBuffer.clear();
    this._wakeQueue.length = 0;
    this._wakingDocs.clear();
    this._warmLRU.clear();
    this._warmLeases.clear();
    this._managedFiles.clear();
    this.updateMetrics();
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Buffer a raw update for a hibernated file.
   * Uses Y.mergeUpdates to compact multiple updates into one blob.
   */
  bufferUpdate(guid: string, update: Uint8Array): void {
    const existing = this._hibernationBuffer.get(guid);
    if (existing) {
      this._hibernationBuffer.set(guid, Y.mergeUpdates([existing, update]));
    } else {
      this._hibernationBuffer.set(guid, update);
    }
  }

  /**
   * Reset (or start) the hibernate timer for a warm file.
   * When the timer fires, the file transitions warm → hibernated.
   */
  private resetHibernateTimer(guid: string): void {
    this.clearHibernateTimer(guid);
    if (this.ports.isShuttingDown() || this.ports.isDestroyed()) return;
    const timerId = this.ports.timeProvider.setTimeout(() => {
      this._hibernateTimers.delete(guid);
      // Only hibernate if still loaded but not active
      const s = this.getState(guid);
      if (s === 'working' || s === 'cached') {
        this.hibernate(guid);
      }
    }, this.ports.hibernateTimeoutMs);
    this._hibernateTimers.set(guid, timerId);
  }

  private clearHibernateTimer(guid: string): void {
    const timerId = this._hibernateTimers.get(guid);
    if (timerId !== undefined) {
      this.ports.timeProvider.clearTimeout(timerId);
      this._hibernateTimers.delete(guid);
    }
  }

  /**
   * Touch a file in the warm LRU cache (move to most-recent position).
   */
  private touchWarmLRU(guid: string): void {
    if (this.ports.isDestroyed()) {
      return;
    }
    this._warmLRU.delete(guid);
    this._warmLRU.set(guid, this.ports.timeProvider.now());
  }

  private removeFromWarmLRU(guid: string): void {
    this._warmLRU.delete(guid);
  }

  /**
   * Evict the least recently used warm file to free a slot.
   * Skips leased files and files with active async invokes.
   * Returns true if a slot was freed.
   */
  private evictLRU(): boolean {
    for (const [guid] of this._warmLRU) {
      // Skip files leased by an in-flight background operation
      if (this._warmLeases.has(guid)) continue;
      // Skip active files (shouldn't be in LRU, but guard anyway)
      if (this.getState(guid) === 'active') continue;
      if (this._managedFiles.has(guid)) {
        // The file owns its eligibility; hibernate() defers internally
        // on refusal, so success shows up as a state change.
        this.hibernate(guid);
        if (this.getState(guid) === 'hibernated') return true;
        continue;
      }
      const doc = this.ports.getDocument(guid);
      const hsm = doc?.hsm;
      // Skip docs with in-flight async work
      if (hsm?.getActiveInvoke()) continue;
      this.hibernate(guid);
      return true;
    }
    return false;
  }

  private sortWakeQueue(): void {
    this._wakeQueue.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Process the wake queue with bounded concurrency.
   * Wakes files in priority order, up to maxConcurrentWarm.
   */
  private processWakeQueue(): void {
    if (this._isProcessingWakeQueue || this.ports.isDestroyed()) return;
    this._isProcessingWakeQueue = true;

    try {
      while (this._wakeQueue.length > 0 && this._wakingDocs.size < this.ports.maxConcurrentWarm) {
        // Count currently warm (non-active) files
        let warmCount = 0;
        for (const [, state] of this._hibernationState) {
          if (state === 'working') warmCount++;
        }

        // Check concurrency limit (warm + currently waking)
        if (warmCount + this._wakingDocs.size >= this.ports.maxConcurrentWarm) {
          // Try to evict the least recently used warm file to free a slot
          if (!this.evictLRU()) {
            break; // All warm files have active invokes — can't evict
          }
          continue; // Slot freed — re-check counts on next iteration
        }

        const request = this._wakeQueue.shift()!;
        const currentState = this.getState(request.guid);

        // Skip if already warm/active
        if (currentState !== 'hibernated') continue;

        const managed = this._managedFiles.get(request.guid);
        if (managed) {
          if (managed.destroyed) continue;
          this._wakingDocs.add(request.guid);
          managed.wake();
          const managedBuffer = this._hibernationBuffer.get(request.guid);
          if (managedBuffer) {
            this._hibernationBuffer.delete(request.guid);
            managed.applyRemoteUpdate(managedBuffer);
          }
          this._hibernationState.set(request.guid, 'working');
          this.touchWarmLRU(request.guid);
          this.resetHibernateTimer(request.guid);
          this._wakingDocs.delete(request.guid);
          continue;
        }

        const doc = this.ports.getDocument(request.guid);
        const hsm = doc?.hsm;
        if (!hsm) continue;

        this._wakingDocs.add(request.guid);

        // Recreate localDoc destroyed during hibernation
        doc.wake();

        // Background wake: drain buffer and mark warm. The document's
        // applyRemoteUpdate attaches a remoteDoc so the HSM can read
        // remote content during three-way merge.
        const buffered = this._hibernationBuffer.get(request.guid);
        if (buffered) {
          this._hibernationBuffer.delete(request.guid);
          doc.applyRemoteUpdate(buffered);
        }

        this._hibernationState.set(request.guid, 'working');
        this.touchWarmLRU(request.guid);
        this.resetHibernateTimer(request.guid);
        this._wakingDocs.delete(request.guid);

        // Connect provider if requested (for fork reconciliation)
        if (request.connect) {
          doc.connectForForkReconcile?.().catch(() => {});
        }
      }
    } finally {
      this._isProcessingWakeQueue = false;
    }
    this.updateMetrics();
  }

  updateMetrics(force = false): void {
    // Per-slot teardown suppresses metric refreshes after shutdown begins;
    // the owner's destroy publishes the cleared state once, forced.
    if (this.ports.isShuttingDown() && !force) return;
    const stats = this.getWakeQueueStats();
    metrics.setWakeQueueSlots(this.ports.folderGuid, stats.used, stats.pending, stats.total);
    metrics.setHSMDocumentsByState(this.ports.folderGuid, this.getHibernationStateCounts());
  }
}
