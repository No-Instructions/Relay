<script lang="ts">
	import TFolderSuggest from "./TFolderSuggest.svelte";
	import type { App } from "obsidian";
	import type { Writable } from "svelte/store";
	import type { SharedFolders } from "src/SharedFolder";

	export let app: App;
	export let sharedFolders: SharedFolders;
	export let selectedFolder: Writable<string | undefined>;
	export let placeholder = "Choose or create folder...";

	let currentValue = "";

	function getBlockedPaths() {
		return new Set<string>(
			sharedFolders
				.filter((folder) => !!folder.relayId)
				.map((folder) => folder.path),
		);
	}

	// Initialize from external store if it has a value
	$: if ($selectedFolder && $selectedFolder !== currentValue) {
		currentValue = $selectedFolder;
	}

	function handleSelect(e: CustomEvent) {
		const folderPath = e.detail.value;
		currentValue = folderPath;
		selectedFolder.set(folderPath);
	}
</script>

<div class="folder-select-input">
	<TFolderSuggest
		{app}
		{placeholder}
		blockedPaths={getBlockedPaths()}
		bind:value={currentValue}
		on:select={handleSelect}
	/>
</div>
