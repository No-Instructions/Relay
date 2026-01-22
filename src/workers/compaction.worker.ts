/**
 * Web Worker for IndexedDB Y.Doc compaction
 * Compacts accumulated updates into a single state snapshot
 */
import * as Y from 'yjs';
import * as idb from 'lib0/indexeddb';

const updatesStoreName = 'updates';

export interface CompactionRequest {
    id: string;
    type: 'compact';
    dbName: string;
}

export interface CompactionResponse {
    id: string;
    success: boolean;
    dbName: string;
    countBefore?: number;
    countAfter?: number;
    error?: string;
}

/**
 * Compact a Y.Doc IndexedDB database
 * Reads all updates, merges them into a single state, and replaces them
 */
async function compactDatabase(dbName: string): Promise<{ countBefore: number; countAfter: number }> {
    // Open the IndexedDB database
    const db = await idb.openDB(dbName, (db) => {
        idb.createStores(db, [
            ['updates', { autoIncrement: true }],
            ['custom']
        ]);
    });

    try {
        // Get all updates and the last key
        const [readStore] = idb.transact(db, [updatesStoreName], 'readonly');
        const updates: Uint8Array[] = await idb.getAll(readStore);
        const lastKey = await idb.getLastKey(readStore);
        const countBefore = updates.length;

        if (countBefore <= 1) {
            // Nothing to compact
            return { countBefore, countAfter: countBefore };
        }

        // Create a Y.Doc and apply all updates
        const doc = new Y.Doc();
        Y.transact(doc, () => {
            for (const update of updates) {
                Y.applyUpdate(doc, update);
            }
        }, null, false);

        // Encode the compacted state
        const compactedState = Y.encodeStateAsUpdate(doc);
        doc.destroy();

        // Write compacted state and delete old entries
        const [writeStore] = idb.transact(db, [updatesStoreName]);

        // Add the compacted state first (gets a key > lastKey)
        await idb.addAutoKey(writeStore, compactedState);

        // Delete all entries up to and including lastKey
        await idb.del(writeStore, idb.createIDBKeyRangeUpperBound(lastKey, true));

        // Verify the count
        const countAfter = await idb.count(writeStore);

        return { countBefore, countAfter };
    } finally {
        db.close();
    }
}

// Message handler
self.onmessage = async function(evt: MessageEvent<CompactionRequest>) {
    const { id, type, dbName } = evt.data;

    if (type !== 'compact') {
        const response: CompactionResponse = {
            id,
            success: false,
            dbName: dbName || '',
            error: `Unknown operation type: ${type}`
        };
        self.postMessage(response);
        return;
    }

    if (!dbName) {
        const response: CompactionResponse = {
            id,
            success: false,
            dbName: '',
            error: 'dbName is required'
        };
        self.postMessage(response);
        return;
    }

    try {
        const { countBefore, countAfter } = await compactDatabase(dbName);

        const response: CompactionResponse = {
            id,
            success: true,
            dbName,
            countBefore,
            countAfter
        };
        self.postMessage(response);
    } catch (error) {
        const response: CompactionResponse = {
            id,
            success: false,
            dbName,
            error: error instanceof Error ? error.message : String(error)
        };
        self.postMessage(response);
    }
};
