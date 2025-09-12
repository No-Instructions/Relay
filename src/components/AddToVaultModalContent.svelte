<script lang="ts">
	import { App, debounce } from "obsidian";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import FolderSelect from "./FolderSelectInput.svelte";
	import { writable } from "svelte/store";
	import type { RemoteSharedFolder } from "src/Relay";
	import { Vault } from "lucide-svelte";
	import type { SharedFolders } from "src/SharedFolder";
	import { RemoteFolderSuggestModal } from "src/ui/RemoteFolderSuggestModal";
	import Satellite from "./Satellite.svelte";
	import RemoteFolder from "./RemoteFolder.svelte";

	export let app: App;
	export let remoteFolder: RemoteSharedFolder | undefined;
	export let availableFolders: RemoteSharedFolder[] = [];
	export let sharedFolders: SharedFolders;
	export let onConfirm: (
		remoteFolder: RemoteSharedFolder,
		folderName: string,
		folderLocation: string,
	) => Promise<void>;

	let selectedRemoteFolder: RemoteSharedFolder | undefined = remoteFolder;
	let folderName: string = remoteFolder?.name || "";
	let folderLocation = writable<string | undefined>();
	let error: string = "";

	// Update folder name when remote folder selection changes
	$: if (selectedRemoteFolder) {
		folderName = selectedRemoteFolder.name || "";
	}

	// Auto-open folder selector if no folder is pre-selected
	import { onMount } from "svelte";
	
	onMount(() => {
		if (!remoteFolder && availableFolders.length > 0) {
			const modal = new RemoteFolderSuggestModal(
				app,
				sharedFolders,
				undefined, // relayManager not needed for this use case
				availableFolders,
				async (folder) => {
					selectedRemoteFolder = folder;
				},
			);
			modal.open();
		}
	});
</script>

<div class="modal-title">Add to vault</div>

<div class="modal-content">
	{#if !remoteFolder && availableFolders.length > 0}
		<SettingItem
			name="Remote folder"
			description="Choose which remote folder to add to your vault."
		>
			<button
				class="mod-cta"
				on:click={() => {
					const modal = new RemoteFolderSuggestModal(
						app,
						sharedFolders,
						undefined, // relayManager not needed for this use case
						availableFolders,
						async (folder) => {
							selectedRemoteFolder = folder;
						},
					);
					modal.open();
				}}
			>
				Choose a folder...
			</button>
		</SettingItem>

		{#if selectedRemoteFolder}
			<SlimSettingItem>
				<div slot="name" class="breadcrumb-display">
					<Satellite relay={selectedRemoteFolder.relay}>
						{selectedRemoteFolder.relay?.name || "Unknown Relay"}
					</Satellite>
					<span class="breadcrumb-separator">></span>
					<RemoteFolder remoteFolder={selectedRemoteFolder}>
						{selectedRemoteFolder.name || "Unnamed Folder"}
					</RemoteFolder>
				</div>
			</SlimSettingItem>
		{/if}
	{/if}

	<SettingItem
		name="Folder name"
		description="Set the name of the folder to be added."
	>
		<input
			type="text"
			bind:value={folderName}
			disabled={!selectedRemoteFolder}
		/>
	</SettingItem>

	<SettingItem
		name="Folder location"
		description="Set the location in your vault."
	>
		<FolderSelect {app} {sharedFolders} selectedFolder={folderLocation} />
	</SettingItem>

	<div class="modal-button-container">
		{#if error}
			<span class="mod-warning error">{error}</span>
		{/if}
		<button
			class="mod-cta"
			disabled={!selectedRemoteFolder || !folderName.trim()}
			on:click={debounce(async () => {
				if (!selectedRemoteFolder) {
					error = "Please select a remote folder";
					return;
				}
				if (!folderName.trim()) {
					error = "Please enter a folder name";
					return;
				}

				onConfirm(
					selectedRemoteFolder,
					folderName,
					$folderLocation || "",
				).catch((e) => {
					error = e.message;
				});
			})}>Confirm</button
		>
	</div>
</div>

<style>
	span.error {
		flex: auto;
		align-content: center;
	}

	.breadcrumb-display {
		display: flex;
		align-items: center;
		gap: 0.5em;
		font-size: 0.9em;
	}

	.breadcrumb-separator {
		color: var(--text-muted);
		font-weight: normal;
	}
</style>
