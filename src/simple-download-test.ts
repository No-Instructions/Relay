/**
 * Simple function to test downloading a URL in a worker
 * This demonstrates that requestUrl works in worker context
 */
export async function testDownloadInWorker(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        console.log("[Main] Creating worker to download:", url);
        
        // Create worker from inline code since esbuild doesn't support web-worker: imports
        const workerCode = `
            import { requestUrl } from "obsidian";
            
            onmessage = async (evt) => {
                const { url, id } = evt.data;
                
                try {
                    console.log("[Worker] Downloading:", url);
                    
                    const response = await requestUrl({
                        url: url,
                        method: "GET",
                        throw: false,
                    });
                    
                    console.log("[Worker] Download completed:", response.status);
                    
                    postMessage({
                        id,
                        success: true,
                        status: response.status,
                        text: response.text,
                        headers: response.headers
                    });
                    
                } catch (error) {
                    console.error("[Worker] Download failed:", error);
                    
                    postMessage({
                        id,
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            };
        `;
        
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
        const taskId = `test_${Date.now()}`;
        
        worker.onmessage = (evt: MessageEvent) => {
            const { id, success, status, text, headers, error } = evt.data;
            
            if (id === taskId) {
                worker.terminate();
                URL.revokeObjectURL(worker.constructor.name); // Clean up blob URL
                
                if (success) {
                    console.log("[Main] Worker download succeeded:", status);
                    resolve({ status, text, headers });
                } else {
                    console.error("[Main] Worker download failed:", error);
                    reject(new Error(error));
                }
            }
        };
        
        worker.onerror = (error: ErrorEvent) => {
            console.error("[Main] Worker error:", error);
            worker.terminate();
            reject(new Error("Worker error"));
        };
        
        // Send download request to worker
        worker.postMessage({ url, id: taskId });
    });
}

/**
 * Test function that downloads a public URL and writes result to a file
 * This shows the pattern: worker downloads, main thread writes to vault
 */
export async function testWorkerDownloadAndSave(
    url: string, 
    filename: string,
    vault: any
): Promise<void> {
    try {
        console.log("[Main] Starting worker download test...");
        
        // Download in worker
        const result = await testDownloadInWorker(url);
        
        // Write to vault in main thread
        await vault.create(filename, result.text);
        
        console.log(`[Main] Successfully downloaded and saved to ${filename}`);
        console.log(`[Main] Status: ${result.status}, Content length: ${result.text.length}`);
        
    } catch (error) {
        console.error("[Main] Test failed:", error);
        throw error;
    }
}