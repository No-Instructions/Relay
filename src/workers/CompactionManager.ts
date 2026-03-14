/**
 * CompactionManager - coordinates background compaction via Web Worker
 */
import type { CompactionRequest, CompactionResponse } from './compaction.worker';

// @ts-ignore - esbuild-plugin-inline-worker handles this import
import CompactionWorker from './compaction.worker.ts';

export class CompactionManager {
    private static _instance: CompactionManager | null = null;
    private worker: Worker | null = null;
    private pendingRequests = new Map<string, {
        resolve: (result: { countBefore: number; countAfter: number }) => void;
        reject: (error: Error) => void;
    }>();
    private nextId = 0;

    private constructor() {
        this.initWorker();
    }

    static get instance(): CompactionManager {
        if (!CompactionManager._instance) {
            CompactionManager._instance = new CompactionManager();
        }
        return CompactionManager._instance;
    }

    static destroy(): void {
        if (CompactionManager._instance) {
            CompactionManager._instance.terminate();
            CompactionManager._instance = null;
        }
    }

    private initWorker(): void {
        try {
            this.worker = new CompactionWorker();
            this.worker!.onmessage = this.handleMessage.bind(this);
            this.worker!.onerror = this.handleError.bind(this);
        } catch (error) {
            console.error('[CompactionManager] Failed to create worker:', error);
            this.worker = null;
        }
    }

    private handleMessage(evt: MessageEvent<CompactionResponse>): void {
        const { id, success, countBefore, countAfter, error } = evt.data;
        const pending = this.pendingRequests.get(id);

        if (!pending) {
            console.warn('[CompactionManager] Received response for unknown request:', id);
            return;
        }

        this.pendingRequests.delete(id);

        if (success && countBefore !== undefined && countAfter !== undefined) {
            pending.resolve({ countBefore, countAfter });
        } else {
            pending.reject(new Error(error || 'Compaction failed'));
        }
    }

    private handleError(evt: ErrorEvent): void {
        console.error('[CompactionManager] Worker error:', evt);
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('Worker error: ' + evt.message));
        }
        this.pendingRequests.clear();
    }

    /**
     * Compact a database in the background worker
     * @param dbName The IndexedDB database name to compact
     * @returns Promise resolving to compaction stats
     */
    async compact(dbName: string): Promise<{ countBefore: number; countAfter: number }> {
        if (!this.worker) {
            throw new Error('Compaction worker not available');
        }

        const id = String(this.nextId++);

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            const request: CompactionRequest = {
                id,
                type: 'compact',
                dbName
            };

            this.worker!.postMessage(request);
        });
    }

    /**
     * Check if the worker is available
     */
    get available(): boolean {
        return this.worker !== null;
    }

    private terminate(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        // Reject any pending requests
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('CompactionManager terminated'));
        }
        this.pendingRequests.clear();
    }
}
