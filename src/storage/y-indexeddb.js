import * as Y from 'yjs'
import * as idb from 'lib0/indexeddb'
import * as promise from 'lib0/promise'
import { Observable } from 'lib0/observable'
import { metrics } from '../debug'
import { CompactionManager } from '../workers/CompactionManager'

const customStoreName = 'custom'
const updatesStoreName = 'updates'

/**
 * Compare two Uint8Arrays for equality
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
const uint8ArrayEquals = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Use a higher threshold on startup to avoid slow initial compaction
// After sync, use the lower threshold to keep the database lean
export const STARTUP_TRIM_SIZE = 500
export const RUNTIME_TRIM_SIZE = 50

/**
 * Check if a database needs compaction and compact it in a worker if so.
 * This should be called BEFORE creating an IndexeddbPersistence instance.
 * @param {string} name - The database name
 * @returns {Promise<void>}
 */
export const maybeCompactDatabase = async (name) => {
  if (!CompactionManager.instance.available) {
    return
  }

  // Open a temporary connection just to check the count
  const tempDb = await idb.openDB(name, db =>
    idb.createStores(db, [
      ['updates', { autoIncrement: true }],
      ['custom']
    ])
  )

  try {
    const [checkStore] = idb.transact(tempDb, [updatesStoreName], 'readonly')
    const count = await idb.count(checkStore)

    if (count >= STARTUP_TRIM_SIZE) {
      // Close our temp connection before worker compacts
      tempDb.close()

      try {
        const result = await CompactionManager.instance.compact(name)
        metrics.recordCompaction(name, 0)
        console.log(`[y-indexeddb] Compacted ${name}: ${result.countBefore} -> ${result.countAfter}`)
      } catch (err) {
        console.warn(`[y-indexeddb] Background compaction failed for ${name}:`, err)
      }
      return
    }
  } finally {
    // Close temp connection if still open
    try {
      tempDb.close()
    } catch (e) {
      // Already closed
    }
  }
}

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {function(IDBObjectStore):void} [beforeApplyUpdatesCallback]
 * @param {function(IDBObjectStore):void} [afterApplyUpdatesCallback]
 */
export const fetchUpdates = (idbPersistence, beforeApplyUpdatesCallback = () => {}, afterApplyUpdatesCallback = () => {}) => {
  const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (idbPersistence.db), [updatesStoreName]) // , 'readonly')
  return idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(idbPersistence._dbref, false)).then(updates => {
    if (!idbPersistence._destroyed) {
      beforeApplyUpdatesCallback(updatesStore)
      Y.transact(idbPersistence.doc, () => {
        updates.forEach(val => Y.applyUpdate(idbPersistence.doc, val))
      }, idbPersistence, false)
    }
  })
    .then(() => idb.getLastKey(updatesStore).then(lastKey => { idbPersistence._dbref = lastKey + 1 }))
    .then(() => idb.count(updatesStore).then(cnt => {
      idbPersistence._dbsize = cnt
      metrics.setDbSize(idbPersistence.name, cnt)
    }))
    .then(() => {
      if (!idbPersistence._destroyed) {
        afterApplyUpdatesCallback(updatesStore)
      }
      return updatesStore
    })
}

/**
 * @param {IndexeddbPersistence} idbPersistence
 * @param {boolean} forceStore
 */
export const storeState = (idbPersistence, forceStore = true) =>
  fetchUpdates(idbPersistence)
    .then(updatesStore => {
      if (forceStore || idbPersistence._dbsize >= RUNTIME_TRIM_SIZE) {
        const compactedState = Y.encodeStateAsUpdate(idbPersistence.doc)
        const startTime = performance.now()
        idb.addAutoKey(updatesStore, compactedState)
          .then(() => idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(idbPersistence._dbref, true)))
          .then(() => idb.count(updatesStore).then(cnt => {
            idbPersistence._dbsize = cnt
            metrics.setDbSize(idbPersistence.name, cnt)
          }))
          .then(() => {
            const durationSeconds = (performance.now() - startTime) / 1000
            metrics.recordCompaction(idbPersistence.name, durationSeconds)
          })
      }
    })

/**
 * @param {string} name
 */
export const clearDocument = name => idb.deleteDB(name)

/**
 * @extends Observable<string>
 */
export class IndexeddbPersistence extends Observable {
  /**
   * @param {string} name
   * @param {Y.Doc} doc
   */
  constructor (name, doc) {
    super()
    this.doc = doc
    this.name = name
    this._dbref = 0
    this._dbsize = 0
    this._destroyed = false
    /**
     * @type {IDBDatabase|null}
     */
    this.db = null
    this.synced = false
    this._serverSynced = undefined
    this._origin = undefined
    // First check if compaction is needed, then open the DB
    this._db = maybeCompactDatabase(name).then(() =>
      idb.openDB(name, db =>
        idb.createStores(db, [
          ['updates', { autoIncrement: true }],
          ['custom']
        ])
      )
    )
    /**
     * @type {Promise<IndexeddbPersistence>}
     */
    this.whenSynced = promise.create(resolve => this.on('synced', () => resolve(this)))

    this._db.then(db => {
      this.db = db
      // Capture pending state before loading from IDB
      /** @type {Uint8Array|null} */
      let pendingState = null
      /**
       * @param {IDBObjectStore} updatesStore
       */
      const beforeApplyUpdatesCallback = (updatesStore) => {
        // Capture any in-memory state before loading from IDB
        pendingState = Y.encodeStateAsUpdate(doc)
      }
      const afterApplyUpdatesCallback = (updatesStore) => {
        if (this._destroyed) return this
        // After loading from IDB, check if pending state had anything new
        if (pendingState && pendingState.length > 2) {
          const vectorBeforePending = Y.encodeStateVector(doc)
          Y.applyUpdate(doc, pendingState, this)
          const vectorAfterPending = Y.encodeStateVector(doc)
          const changed = !uint8ArrayEquals(vectorBeforePending, vectorAfterPending)
          // Only write if applying pending state actually changed something
          if (changed) {
            idb.addAutoKey(updatesStore, pendingState)
          }
        }
        this.synced = true
        this.emit('synced', [this])
      }
      fetchUpdates(this, beforeApplyUpdatesCallback, afterApplyUpdatesCallback)
    })
    /**
     * Timeout in ms untill data is merged and persisted in idb.
     */
    this._storeTimeout = 1000
    /**
     * @type {any}
     */
    this._storeTimeoutId = null
    /**
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._storeUpdate = (update, origin) => {
      if (this.db && origin !== this) {
        // Skip updates with empty state vectors (no actual content)
        const stateVector = Y.encodeStateVectorFromUpdate(update)
        if (stateVector.length === 0) {
          return
        }
        const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (this.db), [updatesStoreName])
        idb.addAutoKey(updatesStore, update)
        ++this._dbsize
        metrics.setDbSize(this.name, this._dbsize)
        const trimSize = this.synced ? RUNTIME_TRIM_SIZE : STARTUP_TRIM_SIZE
        if (this._dbsize >= trimSize) {
          // debounce store call
          if (this._storeTimeoutId !== null) {
            clearTimeout(this._storeTimeoutId)
          }
          this._storeTimeoutId = setTimeout(() => {
            storeState(this, false)
            this._storeTimeoutId = null
          }, this._storeTimeout)
        }
      }
    }
    doc.on('update', this._storeUpdate)
    this.destroy = this.destroy.bind(this)
    doc.on('destroy', this.destroy)
  }

  /**
   * Override once to handle race condition where event might have already fired
   * @param {string} name
   * @param {function} f
   */
  once (name, f) {
    if (name === 'synced' && this.synced) {
      // If already synced, call immediately in next tick
      setTimeout(() => f(this), 0)
      return this
    }
    return super.once(name, f)
  }

  destroy () {
    if (this._storeTimeoutId) {
      clearTimeout(this._storeTimeoutId)
    }
    this.doc.off('update', this._storeUpdate)
    this.doc.off('destroy', this.destroy)
    this._destroyed = true
    return this._db.then(db => {
      db.close()
    })
  }

  /**
   * Destroys this instance and removes all data from indexeddb.
   *
   * @return {Promise<void>}
   */
  clearData () {
    return this.destroy().then(() => {
      idb.deleteDB(this.name)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<String | number | ArrayBuffer | Date | any>}
   */
  get (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName], 'readonly')
      return idb.get(custom, key)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @param {String | number | ArrayBuffer | Date} value
   * @return {Promise<String | number | ArrayBuffer | Date>}
   */
  set (key, value) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName])
      return idb.put(custom, value, key)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<undefined>}
   */
  del (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName])
      return idb.del(custom, key)
    })
  }

  /**
   * Check if this database contains meaningful user data
   * (more than just initial metadata)
   * @return {boolean}
   */
  hasUserData () {
    return this._dbsize > 3
  }

  /**
   * Server sync state management
   */

  /**
   * Mark this document as synced with the server
   * @return {Promise<any>}
   */
  async markServerSynced () {
    this._serverSynced = true
    return this.set("serverSync", 1)
  }

  /**
   * Get server sync status
   * @return {Promise<boolean>}
   */
  async getServerSynced () {
    if (this._serverSynced !== undefined) {
      return this._serverSynced
    }
    const serverSync = await this.get("serverSync")
    this._serverSynced = serverSync === 1
    return this._serverSynced
  }

  /**
   * Check if document has been synced with server (synchronous)
   * @return {boolean}
   */
  get hasServerSync () {
    return this._serverSynced === true
  }

  /**
   * Origin tracking
   */

  /**
   * Set the origin of this document
   * @param {"local" | "remote"} origin
   * @return {Promise<any>}
   */
  async setOrigin (origin) {
    this._origin = origin
    return this.set("origin", origin)
  }

  /**
   * Get the origin of this document
   * @return {Promise<"local" | "remote" | undefined>}
   */
  async getOrigin () {
    if (this._origin !== undefined) {
      return this._origin
    }
    this._origin = await this.get("origin")
    return this._origin
  }

  /**
   * Enhanced readiness detection
   */

  /**
   * Check if the document is ready for use
   * @param {boolean} providerSynced - whether the provider is synced
   * @return {boolean}
   */
  isReady (providerSynced = false) {
    return this.synced && (providerSynced || this.hasServerSync || this._origin === "local")
  }

  /**
   * Check if this document is awaiting server updates
   * @return {Promise<boolean>}
   */
  async awaitingServerUpdates () {
    const serverSynced = await this.getServerSynced()
    const origin = await this.getOrigin()
    return !serverSynced && origin !== "local" && !this.hasUserData()
  }
}

// =============================================================================
// Doc-less Operations (for MergeHSM idle mode)
// =============================================================================
//
// These operations allow working with Yjs updates without loading a full YDoc
// into memory. Used by MergeHSM for lightweight idle mode.

/**
 * Load raw updates from IndexedDB without creating a YDoc.
 * For lightweight idle mode operations.
 * @param {string} name - Database name (e.g., `${appId}-relay-doc-${guid}`)
 * @returns {Promise<Uint8Array[]>}
 */
export const loadUpdatesRaw = async (name) => {
  const db = await idb.openDB(name, db =>
    idb.createStores(db, [
      ['updates', { autoIncrement: true }],
      ['custom']
    ])
  )
  try {
    const [store] = idb.transact(db, [updatesStoreName], 'readonly')
    const updates = await idb.getAll(store)
    return updates
  } finally {
    db.close()
  }
}

/**
 * Append a Yjs update to IndexedDB without loading a YDoc.
 * For receiving remote updates in idle mode.
 * @param {string} name - Database name
 * @param {Uint8Array} update - Yjs update to store
 * @returns {Promise<void>}
 */
export const appendUpdateRaw = async (name, update) => {
  // Skip updates with empty state vectors (no actual content)
  const stateVector = Y.encodeStateVectorFromUpdate(update)
  if (stateVector.length === 0) {
    return
  }

  const db = await idb.openDB(name, db =>
    idb.createStores(db, [
      ['updates', { autoIncrement: true }],
      ['custom']
    ])
  )
  try {
    const [store] = idb.transact(db, [updatesStoreName], 'readwrite')
    await idb.addAutoKey(store, update)
  } finally {
    db.close()
  }
}

/**
 * Get merged update and state vector without loading a YDoc.
 * Useful for computing state in idle mode.
 * @param {string} name - Database name
 * @returns {Promise<{update: Uint8Array, stateVector: Uint8Array}>}
 */
export const getMergedStateWithoutDoc = async (name) => {
  const updates = await loadUpdatesRaw(name)
  if (updates.length === 0) {
    return { update: new Uint8Array(), stateVector: new Uint8Array() }
  }
  const merged = Y.mergeUpdates(updates)
  const stateVector = Y.encodeStateVectorFromUpdate(merged)
  return { update: merged, stateVector }
}

/**
 * Get the state vector from stored updates without loading a YDoc.
 * @param {string} name - Database name
 * @returns {Promise<Uint8Array>}
 */
export const getStateVectorWithoutDoc = async (name) => {
  const { stateVector } = await getMergedStateWithoutDoc(name)
  return stateVector
}

/**
 * Compute the diff between stored updates and a remote state vector.
 * Returns the updates needed to bring remote up to date with local.
 * Does not load a YDoc.
 * @param {string} name - Database name
 * @param {Uint8Array} remoteStateVector - Remote state vector to diff against
 * @returns {Promise<Uint8Array>} - Update containing changes remote doesn't have
 */
export const diffUpdatesWithoutDoc = async (name, remoteStateVector) => {
  const { update } = await getMergedStateWithoutDoc(name)
  if (update.length === 0) {
    return new Uint8Array()
  }
  return Y.diffUpdate(update, remoteStateVector)
}
