<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { FolderSuggest } from "../ui/FolderSuggest";
	import type { App } from "obsidian";
	import { writable } from "svelte/store";
	import type { SharedFolders } from "src/SharedFolder";

	export let app: App;

	let inputEl: HTMLInputElement;
	let folderSuggest: FolderSuggest;
	export let sharedFolders: SharedFolders;
	export let selectedFolder = writable<string | undefined>();

	onMount(() => {
		folderSuggest = new FolderSuggest(app, sharedFolders, inputEl);

		// Custom event listener for folder selection
		const handleFolderSelect = (event: CustomEvent) => {
			selectedFolder = event.detail.folder.path;
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
		placeholder="/"
		on:input={handleInput}
		bind:value={$selectedFolder}
	/>
</div>
