<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { FolderSuggest } from "../FolderSuggest";
	import type { App } from "obsidian";

	export let app: App;
	export let onFolderSelect: (folderPath: string) => void;

	let inputEl: HTMLInputElement;
	let folderSuggest: FolderSuggest;
	export let selectedFolder = "";

	onMount(() => {
		folderSuggest = new FolderSuggest(inputEl, app);

		// Custom event listener for folder selection
		const handleFolderSelect = (event: CustomEvent) => {
			selectedFolder = event.detail.folder.path;
			onFolderSelect(selectedFolder);
		};

		inputEl.addEventListener(
			"folder-selected",
			handleFolderSelect as EventListener,
		);

		return () => {
			inputEl.removeEventListener(
				"folder-selected",
				handleFolderSelect as EventListener,
			);
		};
	});

	onDestroy(() => {
		if (folderSuggest) {
			folderSuggest.close();
		}
	});

	function handleInput() {
		// You can add additional logic here if needed
	}
</script>

<div class="folder-suggest-container">
	<input
		bind:this={inputEl}
		type="text"
		placeholder="Select a folder"
		on:input={handleInput}
		value={selectedFolder}
	/>
</div>
