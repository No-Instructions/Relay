<script lang="ts">
	import { App, debounce } from "obsidian";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import FolderSelectInput from "./FolderSelectInput.svelte";
	import SelectedFolder from "./SelectedFolder.svelte";
	import { writable } from "svelte/store";
	import type { RemoteSharedFolder } from "src/Relay";
	import type { SharedFolders } from "src/SharedFolder";
	import { RemoteFolderSuggestModal } from "src/ui/RemoteFolderSuggestModal";
	import { onDestroy, onMount } from "svelte";

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
	let folderLocation = writable<string | undefined>("/");
	let error: string = "";
	let previousSelectedFolder: RemoteSharedFolder | undefined = remoteFolder;

	// Reactively update folder name only when a different folder is selected
	$: if (selectedRemoteFolder !== previousSelectedFolder) {
		if (selectedRemoteFolder) {
			folderName = selectedRemoteFolder.name || "";
		}
		previousSelectedFolder = selectedRemoteFolder;
	}

	const suggestModal = new RemoteFolderSuggestModal(
		app,
		availableFolders,
		(folder: RemoteSharedFolder) => {
			selectedRemoteFolder = folder;
		},
	);

	onMount(() => {
		// Auto-open folder selection prompt if no folder is selected
		if (!remoteFolder && availableFolders.length > 0) {
			setTimeout(() => {
				suggestModal.open();
			}, 100);
		}
	});

	onDestroy(() => {
		suggestModal.close();
		suggestModal.destroy();
	});
</script>

<div class="modal-title">Add to vault</div>

<div class="modal-content">
	{#if !remoteFolder && availableFolders.length > 0}
		<div class="section">
			<SettingItemHeading name="Remote folder" />
			<SelectedFolder
				selectedItem={selectedRemoteFolder}
				selectButtonText="Choose a folder..."
				on:clear={() => {
					selectedRemoteFolder = undefined;
					folderName = "";
				}}
				on:select={() => {
					suggestModal.open();
				}}
			/>
		</div>
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
		<FolderSelectInput {app} {sharedFolders} selectedFolder={folderLocation} />
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
					$folderLocation || "/",
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

	.section {
		margin-bottom: 24px;
	}
</style>
