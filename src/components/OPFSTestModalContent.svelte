<script lang="ts">
	import { writable } from "svelte/store";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type Live from "../main";

	export let plugin: Live;

	let testResult = writable<string>("Not tested");
	let isLoading = writable<boolean>(false);
	let fileOperations = writable<string[]>([]);

	async function testOPFS() {
		isLoading.set(true);
		testResult.set("Testing...");
		fileOperations.set([]);

		try {
			// Check if OPFS is supported
			if (!navigator.storage || !navigator.storage.getDirectory) {
				throw new Error("OPFS (Origin Private File System) is not supported in this browser");
			}

			const operations: string[] = [];

			// Get the OPFS root directory
			operations.push("📁 Getting OPFS root directory...");
			fileOperations.set([...operations]);
			const opfsRoot = await navigator.storage.getDirectory();

			// Create a test file
			const testFileName = `relay-test-${Date.now()}.txt`;
			const testContent = `Test file created at ${new Date().toISOString()}\nThis is a test of OPFS functionality.`;

			operations.push(`📝 Creating test file: ${testFileName}`);
			fileOperations.set([...operations]);
			const fileHandle = await opfsRoot.getFileHandle(testFileName, { create: true });

			// Detect platform capabilities and try different write methods
			operations.push("🔍 Detecting OPFS write capabilities...");
			fileOperations.set([...operations]);

			let writeSuccess = false;
			let writeMethod = "";

			// Method 1: Try File System Access API (createWritable)
			if (typeof fileHandle.createWritable === 'function') {
				try {
					operations.push("✍️ Trying File System Access API (createWritable)...");
					fileOperations.set([...operations]);
					const writable = await fileHandle.createWritable();
					await writable.write(testContent);
					await writable.close();
					writeSuccess = true;
					writeMethod = "File System Access API (createWritable)";
					operations.push("✅ createWritable() method successful");
				} catch (error) {
					operations.push(`❌ createWritable() failed: ${error.message}`);
				}
			} else {
				operations.push("❌ createWritable() not available on this platform");
			}

			// Method 2: Try alternative OPFS access patterns if first method failed
			if (!writeSuccess) {
				// Try getting a writable stream differently (some implementations)
				if (typeof (fileHandle as any).getWritable === 'function') {
					try {
						operations.push("✍️ Trying alternative getWritable() method...");
						fileOperations.set([...operations]);
						const writable = await (fileHandle as any).getWritable();
						await writable.write(testContent);
						await writable.close();
						writeSuccess = true;
						writeMethod = "Alternative getWritable()";
						operations.push("✅ getWritable() method successful");
					} catch (error) {
						operations.push(`❌ getWritable() failed: ${error.message}`);
					}
				}
			}

			// Method 3: Try direct file creation if handle-based writing fails
			if (!writeSuccess) {
				try {
					operations.push("✍️ Trying direct file creation with Blob...");
					fileOperations.set([...operations]);
					
					// Remove the test file first
					try {
						await opfsRoot.removeEntry(testFileName);
					} catch (e) {
						// File might not exist, that's OK
					}
					
					// Create new file with content
					const newFileHandle = await opfsRoot.getFileHandle(testFileName, { create: true });
					
					// Some platforms support creating writable from fresh handles
					if (typeof newFileHandle.createWritable === 'function') {
						const writable = await newFileHandle.createWritable();
						await writable.write(testContent);
						await writable.close();
						writeSuccess = true;
						writeMethod = "Fresh handle createWritable()";
						operations.push("✅ Fresh handle write successful");
					} else {
						throw new Error("No writable methods available");
					}
				} catch (error) {
					operations.push(`❌ Direct file creation failed: ${error.message}`);
				}
			}

			if (!writeSuccess) {
				throw new Error("All OPFS write methods failed - platform may have limited OPFS support");
			}

			fileOperations.set([...operations]);

			// Read from the file
			operations.push("📖 Reading content from file...");
			fileOperations.set([...operations]);
			const file = await fileHandle.getFile();
			const readContent = await file.text();

			// Verify content matches
			if (readContent === testContent) {
				operations.push("✅ Content verification: PASSED");
			} else {
				operations.push("❌ Content verification: FAILED");
				throw new Error("Read content doesn't match written content");
			}

			// List files in directory
			operations.push("📋 Listing files in OPFS root...");
			fileOperations.set([...operations]);
			const fileNames: string[] = [];
			for await (const [name, handle] of opfsRoot.entries()) {
				fileNames.push(`${handle.kind === 'file' ? '📄' : '📁'} ${name}`);
			}
			operations.push(`Found ${fileNames.length} items: ${fileNames.join(', ')}`);

			// Get file info
			operations.push("ℹ️ Getting file information...");
			fileOperations.set([...operations]);
			operations.push(`File size: ${file.size} bytes`);
			operations.push(`File type: ${file.type || 'text/plain'}`);
			operations.push(`Last modified: ${new Date(file.lastModified).toISOString()}`);

			// Clean up: delete the test file
			operations.push("🗑️ Cleaning up test file...");
			fileOperations.set([...operations]);
			await opfsRoot.removeEntry(testFileName);

			operations.push(`✅ Test completed successfully using: ${writeMethod}`);
			fileOperations.set([...operations]);
			testResult.set(`✅ SUCCESS: OPFS functional via ${writeMethod}`);

		} catch (error) {
			const operations = $fileOperations;
			operations.push(`❌ ERROR: ${error.message}`);
			fileOperations.set([...operations]);
			testResult.set(`❌ FAILED: ${error.message}`);
			console.error('OPFS test failed:', error);
		} finally {
			isLoading.set(false);
		}
	}

	async function checkOPFSQuota() {
		try {
			if (navigator.storage && navigator.storage.estimate) {
				const estimate = await navigator.storage.estimate();
				return {
					quota: estimate.quota ? `${Math.round(estimate.quota / 1024 / 1024)} MB` : 'Unknown',
					usage: estimate.usage ? `${Math.round(estimate.usage / 1024 / 1024)} MB` : 'Unknown',
					available: estimate.quota && estimate.usage ? 
						`${Math.round((estimate.quota - estimate.usage) / 1024 / 1024)} MB` : 'Unknown'
				};
			}
			return { quota: 'N/A', usage: 'N/A', available: 'N/A' };
		} catch (error) {
			return { quota: 'Error', usage: 'Error', available: 'Error' };
		}
	}

	function clearResults() {
		testResult.set("Not tested");
		fileOperations.set([]);
	}

	// Check quota on component mount
	let quotaInfo = { quota: 'Loading...', usage: 'Loading...', available: 'Loading...' };
	checkOPFSQuota().then(info => quotaInfo = info);

	// Platform detection helpers
	function getCreateWritableSupport() {
		try {
			return typeof FileSystemFileHandle !== 'undefined' && FileSystemFileHandle.prototype.createWritable ? '✅' : '❌';
		} catch {
			return '❌';
		}
	}

	function getFileSystemAccessSupport() {
		try {
			return typeof window.showOpenFilePicker !== 'undefined' ? '✅' : '❌';
		} catch {
			return '❌';
		}
	}

	function getCapacitorDetection() {
		try {
			return typeof (window as any).Capacitor !== 'undefined' ? '✅' : '❌';
		} catch {
			return '❌';
		}
	}
</script>

<div class="modal-title">OPFS Test</div>
<div class="modal-content">
	<SettingItemHeading name="Origin Private File System Test">
		<button
			on:click={testOPFS}
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

	<SettingItem name="Test Result" description="Shows whether OPFS is supported and functional">
		<div style="font-family: monospace; white-space: pre-wrap; word-break: break-all;">
			{$testResult}
		</div>
	</SettingItem>

	<SettingItem name="Browser Support" description="OPFS API availability">
		{navigator.storage && navigator.storage.getDirectory ? '✅ OPFS API available' : '❌ OPFS API not available'}
	</SettingItem>

	<SettingItem name="Write Methods" description="Available OPFS write capabilities">
		<div style="font-family: monospace; font-size: 12px;">
			createWritable: {getCreateWritableSupport()}<br/>
			File System Access: {getFileSystemAccessSupport()}<br/>
			Capacitor detected: {getCapacitorDetection()}
		</div>
	</SettingItem>

	<SettingItem name="Storage Quota" description="Total storage quota available">
		{quotaInfo.quota}
	</SettingItem>

	<SettingItem name="Storage Usage" description="Currently used storage">
		{quotaInfo.usage}
	</SettingItem>

	<SettingItem name="Available Storage" description="Remaining storage space">
		{quotaInfo.available}
	</SettingItem>

	<SettingItem name="Platform Info" description="Current platform details">
		{navigator.userAgent}
	</SettingItem>

	{#if $fileOperations.length > 0}
		<SettingItemHeading name="Test Operations Log" />
		<SettingItem name="" description="">
			<div slot="description">
				<div style="font-family: monospace; font-size: 12px; background: var(--background-modifier-border); padding: 8px; border-radius: 4px; max-height: 200px; overflow-y: auto;">
					{#each $fileOperations as operation}
						<div style="margin-bottom: 2px;">{operation}</div>
					{/each}
				</div>
			</div>
		</SettingItem>
	{/if}
</div>