import * as Y from 'yjs'
import * as idb from 'lib0/indexeddb'
import * as promise from 'lib0/promise'
import { Observable } from 'lib0/observable'
import { metrics } from '../debug'

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

/**
 * Validate a Yjs update by applying it to a throwaway doc.
 * Returns null if valid, or the Error if invalid.
 * @param {Uint8Array} update
 * @returns {Error|null}
 */
const validateUpdate = (update) => {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, update)
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  } finally {
    doc.destroy()
  }
}

// Use a higher threshold on startup to avoid slow initial compaction
// After sync, use the lower threshold to keep the database lean
export const STARTUP_TRIM_SIZE = 500
export const RUNTIME_TRIM_SIZE = 50

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
      // Validate each update on a throwaway doc BEFORE applying to the real doc.
      // A corrupted update can partially integrate items (advancing the client clock)
      // before throwing. If we catch after the fact, the doc has phantom clock entries
      // that make future remote diffs compute as empty — causing silent data divergence.
      const validUpdates = updates.filter(val => {
        const err = validateUpdate(val)
        if (!err) return true
        console.error(`[y-indexeddb] Filtering out corrupted update from IDB for ${idbPersistence.name} (${val.byteLength} bytes):`, err)
        return false
      })
      if (validUpdates.length < updates.length) {
        console.error(`[y-indexeddb] Filtered ${updates.length - validUpdates.length}/${updates.length} corrupted updates from IDB for ${idbPersistence.name}`)
      }
      Y.transact(idbPersistence.doc, () => {
        validUpdates.forEach(val => Y.applyUpdate(idbPersistence.doc, val))
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
        // Return the promise chain so callers can await the writes
        return idb.addAutoKey(updatesStore, compactedState)
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
   * @param {string|null} [userId] - User ID for PermanentUserData tracking
   */
  constructor (name, doc, userId = null) {
    super()
    this.doc = doc
    this.name = name
    this._dbref = 0
    this._dbsize = 0
    this._destroyed = false
    this._userId = userId
    /**
     * @type {IDBDatabase|null}
     */
    this.db = null
    this.synced = false
    this._serverSynced = undefined
    this._origin = undefined
    // First check if compaction is needed, then open the DB
    // this._db = maybeCompactDatabase(name).then(() =>
    this._db = Promise.resolve().then(() =>
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
        // Set up PermanentUserData if userId provided and DB has content.
        // This MUST happen AFTER IDB is loaded because PUD advances the client's
        // Yjs clock. If done before IDB loads, subsequent content operations
        // reference post-PUD clock positions that don't exist in IDB.
        // Only set up PUD if file is already enrolled (hasUserData), otherwise
        // we'd write PUD ops before enrollment.
        if (this._userId && this.hasUserData()) {
          this._setupPermanentUserData()
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
     * Track pending write operations for proper teardown.
     * @type {Set<Promise<any>>}
     */
    this._pendingWrites = new Set()
    /**
     * Track pending compaction operation for proper teardown.
     * @type {Promise<void>|null}
     */
    this._pendingCompaction = null
    /**
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._storeUpdate = (update, origin) => {
      if (this.db && origin !== this) {
        const storeErr = validateUpdate(update)
        if (storeErr) {
          console.error(`[y-indexeddb] Dropping invalid update for ${this.name} (${update.byteLength} bytes, not persisted):`, storeErr)
          return
        }
        const [updatesStore] = idb.transact(/** @type {IDBDatabase} */ (this.db), [updatesStoreName])
        const writePromise = idb.addAutoKey(updatesStore, update)
        this._pendingWrites.add(writePromise)
        writePromise.finally(() => {
          this._pendingWrites.delete(writePromise)
        })
        ++this._dbsize
        metrics.setDbSize(this.name, this._dbsize)
        const trimSize = this.synced ? RUNTIME_TRIM_SIZE : STARTUP_TRIM_SIZE
        if (this._dbsize >= trimSize) {
          // debounce store call
          if (this._storeTimeoutId !== null) {
            clearTimeout(this._storeTimeoutId)
          }
          this._storeTimeoutId = setTimeout(() => {
            // Track the compaction promise so destroy() can await it
            this._pendingCompaction = storeState(this, false).finally(() => {
              this._pendingCompaction = null
            })
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

  async destroy () {
    if (this._storeTimeoutId) {
      clearTimeout(this._storeTimeoutId)
    }
    this.doc.off('update', this._storeUpdate)
    this.doc.off('destroy', this.destroy)
    this._destroyed = true
    // Wait for all pending writes to complete before closing
    if (this._pendingWrites.size > 0) {
      await Promise.all(this._pendingWrites)
    }
    // Wait for any pending compaction to complete before closing
    if (this._pendingCompaction) {
      await this._pendingCompaction
    }
    const db = await this._db
    db.close()
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
   * Check if this database contains meaningful user data.
   * Returns true if there are any stored updates in IndexedDB.
   * @return {boolean}
   */
  hasUserData () {
    return this._dbsize > 0
  }

  /**
   * Set up PermanentUserData for user tracking.
   * @private
   */
  _setupPermanentUserData () {
    if (!this._userId) return
    const permanentUserData = new Y.PermanentUserData(this.doc)
    permanentUserData.setUserMapping(this.doc, this.doc.clientID, this._userId)
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
   * Initialize document with content if not already initialized.
   * Checks origin in one IDB session, calls contentLoader only if needed.
   * @param {() => Promise<{content: string, hash: string, mtime: number}>} contentLoader
   * @param {string} [fieldName='contents'] - Y.Text field name
   * @return {Promise<boolean>} true if initialization happened, false if already initialized
   */
  async initializeWithContent (contentLoader, fieldName = 'contents') {
    await this.whenSynced

    // Check if already enrolled (origin set = previously initialized)
    const existingOrigin = await this.getOrigin()
    if (existingOrigin !== undefined) {
      return false
    }

    // Also check for user data (belt and suspenders)
    if (this.hasUserData()) {
      return false
    }

    // Not initialized - load content lazily
    const { content } = await contentLoader()

    // Set up PermanentUserData BEFORE content insertion
    if (this._userId) {
      this._setupPermanentUserData()
    }

    // Insert content
    this.doc.transact(() => {
      const ytext = this.doc.getText(fieldName)
      ytext.insert(0, content)
    })

    // Mark origin
    await this.setOrigin('local')

    return true
  }

  /**
   * Initialize document from remote CRDT state if not already initialized.
   * Used for downloaded documents where remoteDoc already has server content.
   * @param {Uint8Array} update - CRDT update from remoteDoc
   * @return {Promise<boolean>} true if initialization happened, false if already initialized
   */
  async initializeFromRemote (update) {
    await this.whenSynced

    // Check if already initialized (origin set = previously initialized)
    const existingOrigin = await this.getOrigin()
    if (existingOrigin !== undefined) {
      return false
    }

    // Also check for user data (belt and suspenders)
    if (this.hasUserData()) {
      return false
    }

    // Set up PermanentUserData BEFORE applying update
    if (this._userId) {
      this._setupPermanentUserData()
    }

    // Apply remote CRDT state (preserves history, no new operations created)
    Y.applyUpdate(this.doc, update, this)

    // Mark origin
    await this.setOrigin('remote')

    return true
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
  const appendErr = validateUpdate(update)
  if (appendErr) {
    console.error(`[y-indexeddb] Dropping invalid update for ${name} (${update.byteLength} bytes, not persisted):`, appendErr)
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

