<script lang="ts">
	import { App, debounce } from "obsidian";
	import SettingItem from "./SettingItem.svelte";
	import FolderSelect from "./FolderSelectInput.svelte";
	import { writable } from "svelte/store";
	import type { RemoteSharedFolder } from "src/Relay";
	import { Vault } from "lucide-svelte";
	import type { SharedFolders } from "src/SharedFolder";

	export let app: App;
	export let remoteFolder: RemoteSharedFolder;
	export let sharedFolders: SharedFolders;
	export let onConfirm: (
		remoteFolder: RemoteSharedFolder,
		folderName: string,
		folderLocation: string,
	) => void;
	let folderName: string = remoteFolder.name;
	let folderLocation = writable<string | undefined>();
</script>

<div class="modal-title">Add to Vault</div>

<div class="modal-content">
	<SettingItem
		name="Folder Name"
		description="Set the name of the folder to be added."
	>
		<input type="text" bind:value={folderName} />
	</SettingItem>

	<SettingItem
		name="Folder Location"
		description="Set the location in your vault."
	>
		<FolderSelect {app} {sharedFolders} selectedFolder={folderLocation} />
	</SettingItem>

	<div class="modal-button-container">
		<button
			class="mod-cta"
			on:click={debounce(() => {
				onConfirm(remoteFolder, folderName, $folderLocation || "");
			})}>Confirm</button
		>
	</div>
</div>
