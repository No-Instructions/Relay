<script lang="ts">
	import { App, TFolder } from "obsidian";
	import GenericSuggest from "./GenericSuggest.svelte";
	import type { SharedFolders } from "../SharedFolder";
	import { Layers } from "lucide-svelte";

	interface FolderSuggestion {
		path: string;
		isCreate: boolean;
		isShared: boolean;
		hasRelay: boolean;
	}

	export let app: App;
	export let placeholder: string = "Choose or create folder...";
	export let blockedPaths: Set<string> = new Set();
	export let sharedFolders: SharedFolders;
	export let autofocus: boolean = false;
	export let onSelect: (folderPath: string) => void = () => {};

	function getFolderSuggestions(query: string): FolderSuggestion[] {
		// Build maps for shared folders inside the function
		const sharedPathsMap = new Map<string, boolean>();
		if (sharedFolders) {
			// Use forEach since SharedFolders extends ObservableSet
			sharedFolders.forEach((folder) => {
				sharedPathsMap.set(folder.path, !!folder.relayId);
			});
		}
		const lowerQuery = query.toLowerCase();
		const suggestions: FolderSuggestion[] = [];
		const existingPaths = new Set<string>();

		const getAllFoldersRecursively = (folder: TFolder) => {
			if (blockedPaths.has(folder.path) && folder.path !== "/") {
				return;
			}
			// If query is empty, show all folders; otherwise filter by query
			if (!lowerQuery || folder.path.toLowerCase().includes(lowerQuery)) {
				if (!blockedPaths.has(folder.path)) {
					const isShared = sharedPathsMap.has(folder.path);
					const hasRelay = sharedPathsMap.get(folder.path) || false;

					suggestions.push({
						path: folder.path,
						isCreate: false,
						isShared,
						hasRelay,
					});
					existingPaths.add(folder.path.toLowerCase());
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
		if (trimmed && !existingPaths.has(trimmed.toLowerCase())) {
			suggestions.unshift({
				path: trimmed,
				isCreate: true,
				isShared: false,
				hasRelay: false,
			});
		}

		// Sort suggestions
		suggestions.sort((a, b) => {
			// Create options first
			if (a.isCreate && !b.isCreate) return -1;
			if (!a.isCreate && b.isCreate) return 1;

			// Then shared folders without relays
			if (a.isShared && !a.hasRelay && (!b.isShared || b.hasRelay)) return -1;
			if (b.isShared && !b.hasRelay && (!a.isShared || a.hasRelay)) return 1;

			// Then alphabetical
			return a.path.localeCompare(b.path);
		});

		// Limit to 100 suggestions
		return suggestions.slice(0, 100);
	}

	function handleSelect(suggestion: FolderSuggestion) {
		onSelect(suggestion.path);
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
		{#if item.isCreate}
			<span class="suggestion-create-prefix">Create: </span>{item.path}
		{:else}
			{item.path}
		{/if}
	</svelte:fragment>

	<svelte:fragment slot="suggestion-aux" let:item>
		{#if item.isCreate}
			<span class="suggestion-action">Enter to create</span>
		{:else if item.isShared && !item.hasRelay}
			<div class="suggestion-icon">
				<Layers class="system3-svg-icon" size={16} />
			</div>
		{:else}
			<div class="suggestion-icon"></div>
		{/if}
	</svelte:fragment>
</GenericSuggest>

<style>
	.suggestion-create-prefix {
		color: var(--text-muted);
		font-style: italic;
	}

	.suggestion-action {
		color: var(--text-muted);
		font-size: var(--font-smaller);
	}

	.suggestion-icon {
		display: flex;
		align-items: center;
	}

	:global(.system3-svg-icon) {
		color: var(--text-muted);
		opacity: 0.6;
	}
</style>
