/**
 * Manager for Y.Doc IndexedDB operations in web workers
 */
// @ts-ignore - Worker import
import YDocWorker from './workers/ydoc-indexeddb.worker.ts?worker';

interface WorkerMessage {
    id: string;
    type: 'open' | 'compact' | 'getStats' | 'getText';
    dbName?: string;
    payload?: any;
}

interface WorkerResponse {
    id: string;
    success: boolean;
    data?: any;
    error?: string;
}

interface DatabaseStats {
    dbName: string;
    updateCount: number;
    customCount: number;
    needsCompaction: boolean;
    textLength: number;
    metadata: {
        path?: string;
        relay?: string;
        appId?: string;
        s3rn?: string;
        origin?: string;
        serverSync?: boolean;
    };
}

interface CompactionResult {
    dbName: string;
    message: string;
    updateCountBefore: number;
    updateCountAfter: number;
    savedUpdates?: number;
}

export class YDocWorkerManager {
    private worker: Worker | null = null;
    private pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (reason: any) => void }>();

    constructor() {
        this.initWorker();
    }

    private initWorker() {
        try {
            this.worker = new YDocWorker();
            if (this.worker) {
                this.worker.onmessage = this.handleWorkerMessage.bind(this);
                this.worker.onerror = this.handleWorkerError.bind(this);
            }
        } catch (error) {
            console.error('[YDocWorkerManager] Failed to create worker:', error);
        }
    }

    private handleWorkerMessage(evt: MessageEvent<WorkerResponse>) {
        const { id, success, data, error } = evt.data;
        const request = this.pendingRequests.get(id);
        
        if (request) {
            this.pendingRequests.delete(id);
            
            if (success) {
                request.resolve(data);
            } else {
                request.reject(new Error(error || 'Worker operation failed'));
            }
        }
    }

    private handleWorkerError(error: ErrorEvent) {
        console.error('[YDocWorkerManager] Worker error:', error);
        
        // Reject all pending requests
        this.pendingRequests.forEach(({ reject }) => {
            reject(new Error(`Worker error: ${error.message}`));
        });
        this.pendingRequests.clear();
    }

    private sendMessage(message: Omit<WorkerMessage, 'id'>): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.worker) {
                reject(new Error('Worker not available'));
                return;
            }

            const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const fullMessage: WorkerMessage = { id, ...message };
            
            this.pendingRequests.set(id, { resolve, reject });
            
            // Set timeout for worker operations
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Worker operation timed out'));
                }
            }, 30000); // 30 second timeout
            
            this.worker.postMessage(fullMessage);
        });
    }

    /**
     * Open a Y.Doc from IndexedDB in the worker
     */
    async openDocument(dbName: string): Promise<{ message: string; dbName: string }> {
        return this.sendMessage({ type: 'open', dbName });
    }

    /**
     * Get statistics about an IndexedDB database
     */
    async getDatabaseStats(dbName: string): Promise<DatabaseStats> {
        return this.sendMessage({ type: 'getStats', dbName });
    }

    /**
     * Perform compaction on an IndexedDB database
     */
    async compactDatabase(dbName: string): Promise<CompactionResult> {
        return this.sendMessage({ type: 'compact', dbName });
    }

    /**
     * Get the text content from a Y.Doc
     */
    async getDocumentText(dbName: string): Promise<string> {
        const result = await this.sendMessage({ type: 'getText', dbName });
        return result.text;
    }

    /**
     * Scan all databases and find ones that need compaction
     */
    async findDatabasesNeedingCompaction(dbNames: string[]): Promise<string[]> {
        const results = await Promise.allSettled(
            dbNames.map(dbName => this.getDatabaseStats(dbName))
        );
        
        const needingCompaction: string[] = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value.needsCompaction) {
                needingCompaction.push(dbNames[index]);
            }
        });
        
        return needingCompaction;
    }

    /**
     * Perform compaction on multiple databases
     */
    async compactMultipleDatabases(dbNames: string[]): Promise<CompactionResult[]> {
        const results = await Promise.allSettled(
            dbNames.map(dbName => this.compactDatabase(dbName))
        );
        
        const successful: CompactionResult[] = [];
        const failed: string[] = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                successful.push(result.value);
            } else {
                failed.push(dbNames[index]);
                console.error(`[YDocWorkerManager] Failed to compact ${dbNames[index]}:`, result.reason);
            }
        });
        
        if (failed.length > 0) {
            console.warn(`[YDocWorkerManager] Failed to compact ${failed.length} databases:`, failed);
        }
        
        return successful;
    }

    /**
     * Clean up resources
     */
    destroy() {
        if (this.worker) {
            // Reject all pending requests
            this.pendingRequests.forEach(({ reject }) => {
                reject(new Error('YDocWorkerManager destroyed'));
            });
            this.pendingRequests.clear();
            
            this.worker.terminate();
            this.worker = null;
        }
    }
}