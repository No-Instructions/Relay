<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import { Folder, FolderLock, FolderOpen, ArrowRight } from "lucide-svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import type { RemoteSharedFolder } from "src/Relay";

	export let selectedItem: RemoteSharedFolder | string | undefined = undefined;
	export let isPrivate: boolean = false;
	export let showTransformation: boolean = false; // For share folder modal
	export let selectButtonText: string = "Choose a folder...";
	export let readonly: boolean = false; // For users step in share modal

	const dispatch = createEventDispatcher();

	function handleClear() {
		dispatch("clear");
	}

	function handleSelect() {
		dispatch("select");
	}

	// Determine if we have a remote folder (breadcrumbs) or local folder path (string)
	$: isRemoteFolder = selectedItem && typeof selectedItem === "object";
	$: folderPath = typeof selectedItem === "string" ? selectedItem : "";
	$: folderName = folderPath ? folderPath.split("/").pop() || folderPath : "";
</script>

<div class="folder-selector">
	{#if selectedItem}
		<div class="folder-transformation" class:readonly>
			{#if isRemoteFolder}
				<!-- Remote folder with breadcrumbs -->
				<Breadcrumbs
					element="div"
					items={[
						{ type: "relay", relay: selectedItem.relay },
						{ type: "remoteFolder", remoteFolder: selectedItem },
					]}
				/>
			{:else if showTransformation}
				<!-- Local folder with transformation view -->
				<div class="folder-state">
					<FolderOpen class="svg-icon folder-icon" />
					<span class="folder-name">{folderName}</span>
				</div>
				<ArrowRight class="svg-icon arrow-icon" />
				<div class="folder-state">
					{#if isPrivate}
						<FolderLock class="svg-icon folder-icon" />
					{:else}
						<Folder class="svg-icon folder-icon" />
					{/if}
					<span class="folder-name">{folderName}</span>
				</div>
			{:else}
				<!-- Simple folder display -->
				<div class="folder-state">
					<Folder class="svg-icon folder-icon" />
					<span class="folder-name">{folderName}</span>
				</div>
			{/if}

			{#if !readonly}
				<button class="clear-button" on:click={handleClear}>×</button>
			{/if}
		</div>
	{:else}
		<div class="folder-suggest-container">
			<button class="mod-cta folder-select-button" on:click={handleSelect}>
				{selectButtonText}
			</button>
		</div>
	{/if}
</div>

<style>
	.folder-transformation {
		display: flex;
		align-items: center;
		padding: 8px 12px;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		gap: 8px;
	}

	.folder-transformation.readonly {
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
	}

	.folder-state {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.folder-name {
		font-weight: 500;
		color: var(--text-normal);
		white-space: nowrap;
	}

	.clear-button {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 16px;
		padding: 0;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 2px;
		margin-left: auto;
	}

	.clear-button:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.folder-select-button {
		width: 100%;
		min-height: 3em;
		text-align: left;
	}
</style>
