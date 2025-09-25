<script lang="ts">
	import { App, TFolder } from "obsidian";
	import GenericSuggest from "./GenericSuggest.svelte";

	export let app: App;
	export let placeholder: string = "Choose or create folder...";
	export let blockedPaths: Set<string> = new Set();
	export let autofocus: boolean = false;
	export let onSelect: (folderPath: string) => void = () => {};

	function getFolderSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		const folders: string[] = [];

		const getAllFoldersRecursively = (folder: TFolder) => {
			if (blockedPaths.has(folder.path) && folder.path !== "/") {
				return;
			}
			// If query is empty, show all folders; otherwise filter by query
			if (!lowerQuery || folder.path.toLowerCase().includes(lowerQuery)) {
				if (!blockedPaths.has(folder.path)) {
					folders.push(folder.path);
				}
			}
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					getAllFoldersRecursively(child);
				}
			}
		};

		const rootFolder = app.vault.getRoot();
		getAllFoldersRecursively(rootFolder);

		// Add create option if input doesn't match exactly
		const trimmed = query.trim();
		if (trimmed && !folders.includes(trimmed)) {
			folders.unshift(`[Create] ${trimmed}`);
		}

		// Limit to 100 suggestions
		return folders.slice(0, 100);
	}

	function handleSelect(suggestion: string) {
		let finalValue = suggestion;

		// Handle create option
		if (suggestion.startsWith("[Create] ")) {
			finalValue = suggestion.substring(9);
		}

		onSelect(finalValue);
	}

	function handleCustomInput(inputValue: string) {
		// Allow direct input for folder creation
		onSelect(inputValue);
	}
</script>

<GenericSuggest
	{placeholder}
	{autofocus}
	onSelect={handleSelect}
	getSuggestions={getFolderSuggestions}
	instructions={[
		{ command: "↑/↓", purpose: "Navigate" },
		{ command: "Enter", purpose: "Choose and share folder" },
		{ command: "Esc", purpose: "Cancel" },
	]}
	on:customInput={(e) => handleCustomInput(e.detail.value)}
>
	<svelte:fragment slot="suggestion" let:item>
		{#if item.startsWith("[Create] ")}
			<span class="suggestion-create-prefix">Create: </span>{item.substring(9)}
		{:else}
			{item}
		{/if}
	</svelte:fragment>
</GenericSuggest>

<style>
	.suggestion-create-prefix {
		color: var(--text-muted);
		font-style: italic;
	}
</style>
