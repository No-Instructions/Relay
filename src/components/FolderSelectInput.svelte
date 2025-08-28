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

		// Override the selectSuggestion method to prevent auto-selection on typing
		const originalSelectSuggestion = folderSuggest.selectSuggestion.bind(folderSuggest);
		let shouldSelect = false;

		folderSuggest.selectSuggestion = (folder: string) => {
			if (shouldSelect) {
				// If it's a create option, extract the actual folder name
				if (folder.startsWith("[Create] ")) {
					const folderName = folder.substring(9);
					inputEl.value = folderName;
					selectedFolder.set(folderName);
				} else {
					inputEl.value = folder;
					selectedFolder.set(folder);
				}
				folderSuggest.close();
				shouldSelect = false;
			}
		};

		// Listen for Enter or Tab key to enable selection
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				// Let the AbstractInputSuggest handle Enter naturally
				shouldSelect = true;
			} else if (e.key === 'Tab') {
				e.preventDefault();
				// Get the current suggestions and select the first one if available
				const suggestions = folderSuggest.getSuggestions(inputEl.value);
				if (suggestions.length > 0) {
					shouldSelect = true;
					// Handle create option properly
					const firstSuggestion = suggestions[0];
					if (firstSuggestion.startsWith("[Create] ")) {
						const folderName = firstSuggestion.substring(9);
						inputEl.value = folderName;
						selectedFolder.set(folderName);
					} else {
						inputEl.value = firstSuggestion;
						selectedFolder.set(firstSuggestion);
					}
					folderSuggest.close();
				}
			}
		};

		// Listen for mouse down on the suggestion container to enable selection
		const handleMouseDown = () => {
			shouldSelect = true;
		};

		inputEl.addEventListener('keydown', handleKeyDown);
		
		// Add event listener to the document to catch clicks on suggestion items
		document.addEventListener('mousedown', handleMouseDown);

		return () => {
			inputEl.removeEventListener('keydown', handleKeyDown);
			document.removeEventListener('mousedown', handleMouseDown);
		};
	});

	onDestroy(() => {
		if (folderSuggest) {
			folderSuggest.close();
		}
	});

	function handleInput() {
		// Trigger the suggest to update its suggestions
	}
</script>

<div class="folder-suggest-container">
	<input
		bind:this={inputEl}
		type="text"
		placeholder="Choose or create folder..."
		on:input={handleInput}
	/>
</div>
