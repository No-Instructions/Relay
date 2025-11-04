<script lang="ts">
	import { writable } from "svelte/store";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type Live from "../main";

	export let plugin: Live;

	let testResult = writable<string>("Not tested");
	let isLoading = writable<boolean>(false);
	let workerCode = writable<string>("");

	async function testWebWorker() {
		isLoading.set(true);
		testResult.set("Testing...");

		try {
			// Create a web worker that tests both computation and OPFS
			const workerScript = `
				self.onmessage = async function(e) {
					const { type, data } = e.data;
					
					if (type === 'test') {
						try {
							// Test 1: Basic computation
							const sum = data.numbers.reduce((sum, num) => sum + num, 0);
							
							// Test 2: OPFS availability in worker
							const opfsResults = await testOPFSInWorker();
							
							self.postMessage({
								type: 'result',
								data: { 
									sum: sum, 
									message: 'Web Worker is working!',
									opfs: opfsResults
								}
							});
						} catch (error) {
							self.postMessage({
								type: 'error',
								data: { message: error.message }
							});
						}
					}
				};
				
				async function testOPFSInWorker() {
					const results = {
						apiAvailable: false,
						syncAccessSupported: false,
						syncWriteTestSuccess: false,
						syncError: null,
						asyncWriteTestSuccess: false,
						asyncError: null,
						workingMethods: []
					};
					
					try {
						// Check if OPFS is available in worker
						if (!navigator.storage || !navigator.storage.getDirectory) {
							throw new Error('OPFS not available in worker');
						}
						
						results.apiAvailable = true;
						
						// Get OPFS root
						const opfsRoot = await navigator.storage.getDirectory();
						const testFileName = \`worker-test-\${Date.now()}.txt\`;
						const testContent = 'Hello from Web Worker OPFS test!';
						
						// Create file handle
						const fileHandle = await opfsRoot.getFileHandle(testFileName, { create: true });
						
						// Test 1: createSyncAccessHandle (worker-specific API)
						if (typeof fileHandle.createSyncAccessHandle === 'function') {
							results.syncAccessSupported = true;
							
							let accessHandle = null;
							try {
								accessHandle = await fileHandle.createSyncAccessHandle();
								
								// Write synchronously
								const encoder = new TextEncoder();
								const data = encoder.encode(testContent);
								
								// Ensure we start from beginning and truncate any existing content
								accessHandle.truncate(0);
								accessHandle.write(data, { at: 0 });
								accessHandle.flush();
								
								// Read back - create a fresh buffer
								const buffer = new ArrayBuffer(data.length);
								const bytesRead = accessHandle.read(buffer, { at: 0 });
								
								// Close the handle before processing the data
								accessHandle.close();
								accessHandle = null;
								
								const decoder = new TextDecoder();
								const readContent = decoder.decode(buffer.slice(0, bytesRead));
								
								if (readContent === testContent) {
									results.syncWriteTestSuccess = true;
									results.workingMethods.push('createSyncAccessHandle');
								} else {
									results.syncError = \`Content mismatch: expected "\${testContent}", got "\${readContent}"\`;
								}
								
							} catch (error) {
								results.syncError = \`Sync access failed: \${error.message}\`;
							} finally {
								// Ensure handle is always closed
								if (accessHandle) {
									try {
										accessHandle.close();
									} catch (e) {
										// Handle might already be closed
									}
								}
							}
						} else {
							results.syncError = 'createSyncAccessHandle not available';
						}
						
						// Test 2: createWritable (async API) - create a separate test file
						const asyncTestFileName = \`worker-async-test-\${Date.now()}.txt\`;
						if (typeof fileHandle.createWritable === 'function') {
							try {
								const asyncFileHandle = await opfsRoot.getFileHandle(asyncTestFileName, { create: true });
								const writable = await asyncFileHandle.createWritable();
								await writable.write(testContent);
								await writable.close();
								
								const file = await asyncFileHandle.getFile();
								const readContent = await file.text();
								
								if (readContent === testContent) {
									results.asyncWriteTestSuccess = true;
									results.workingMethods.push('createWritable (async)');
								} else {
									results.asyncError = \`Content mismatch: expected "\${testContent}", got "\${readContent}"\`;
								}
								
								// Clean up async test file
								try {
									await opfsRoot.removeEntry(asyncTestFileName);
								} catch (cleanupError) {
									// File cleanup failed, that's okay
								}
								
							} catch (error) {
								results.asyncError = \`Async write failed: \${error.message}\`;
							}
						} else {
							results.asyncError = 'createWritable not available';
						}
						
						// Clean up test file (try to remove regardless of test success)
						try {
							await opfsRoot.removeEntry(testFileName);
						} catch (cleanupError) {
							// File might not exist or be locked, that's okay
						}
						
					} catch (error) {
						results.error = error.message;
					}
					
					return results;
				}
			`;

			const blob = new Blob([workerScript], { type: 'application/javascript' });
			const workerUrl = URL.createObjectURL(blob);
			const worker = new Worker(workerUrl);

			// Set up promise-based communication
			const workerPromise = new Promise((resolve, reject) => {
				worker.onmessage = (e) => {
					const { type, data } = e.data;
					if (type === 'result') {
						resolve(data);
					} else if (type === 'error') {
						reject(new Error(data.message));
					}
				};

				worker.onerror = (error) => {
					reject(error);
				};

				// Timeout after 10 seconds (OPFS operations can be slow)
				setTimeout(() => {
					reject(new Error('Worker timeout'));
				}, 10000);
			});

			// Send test data to worker
			const testNumbers = [1, 2, 3, 4, 5];
			worker.postMessage({
				type: 'test',
				data: { numbers: testNumbers }
			});

			// Wait for result
			const result = await workerPromise;
			worker.terminate();
			URL.revokeObjectURL(workerUrl);

			// Format the result with OPFS information
			let resultText = `✅ Web Worker: ${result.message} (sum: ${result.sum})\n\n`;
			resultText += `📁 OPFS in Worker:\n`;
			resultText += `  API Available: ${result.opfs.apiAvailable ? '✅' : '❌'}\n`;
			resultText += `  Sync Access API: ${result.opfs.syncAccessSupported ? '✅' : '❌'}\n`;
			resultText += `  Sync Write Test: ${result.opfs.syncWriteTestSuccess ? '✅' : '❌'}\n`;
			if (result.opfs.syncError) {
				resultText += `    Sync Error: ${result.opfs.syncError}\n`;
			}
			resultText += `  Async Write Test: ${result.opfs.asyncWriteTestSuccess ? '✅' : '❌'}\n`;
			if (result.opfs.asyncError) {
				resultText += `    Async Error: ${result.opfs.asyncError}\n`;
			}
			if (result.opfs.workingMethods.length > 0) {
				resultText += `  Working Methods: ${result.opfs.workingMethods.join(', ')}\n`;
			} else {
				resultText += `  Working Methods: None\n`;
			}

			testResult.set(resultText);
			workerCode.set(workerScript);

		} catch (error) {
			testResult.set(`❌ FAILED: ${error.message}`);
			console.error('Web Worker test failed:', error);
		} finally {
			isLoading.set(false);
		}
	}

	function clearResults() {
		testResult.set("Not tested");
		workerCode.set("");
	}
</script>

<div class="modal-title">Web Worker Test</div>
<div class="modal-content">
	<SettingItemHeading name="Web Worker Capability Test">
		<button
			on:click={testWebWorker}
			disabled={$isLoading}
		>
			{$isLoading ? 'Testing...' : 'Run Test'}
		</button>
		<button
			on:click={clearResults}
			disabled={$isLoading}
		>
			Clear
		</button>
	</SettingItemHeading>

	<SettingItem name="Test Result" description="Shows whether web workers are supported and functional">
		<div style="font-family: monospace; white-space: pre-wrap; word-break: break-all;">
			{$testResult}
		</div>
	</SettingItem>

	<SettingItem name="Browser Support" description="Basic web worker API availability">
		{typeof Worker !== 'undefined' ? '✅ Worker API available' : '❌ Worker API not available'}
	</SettingItem>

	<SettingItem name="Platform Info" description="Current platform details">
		{navigator.userAgent}
	</SettingItem>

	{#if $workerCode}
		<SettingItemHeading name="Worker Code Used" />
		<SettingItem name="" description="">
			<div slot="description">
				<pre style="font-size: 12px; overflow-x: auto; background: var(--background-modifier-border); padding: 8px; border-radius: 4px;">
{$workerCode}
				</pre>
			</div>
		</SettingItem>
	{/if}
</div>