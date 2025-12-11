<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import type Live from "src/main";
	import { type SharedFolder } from "src/SharedFolder";
	import { debounce } from "obsidian";
	import { createEventDispatcher, onDestroy, onMount } from "svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";

	export let plugin: Live;
	export let sharedFolder: SharedFolder;

	const dispatch = createEventDispatcher();

	async function handleDeleteMetadata() {
		if (sharedFolder) {
			plugin.sharedFolders.delete(sharedFolder);
		}
		dispatch("goBack", { clear: true });
	}

	function handleDeleteLocal() {
		if (sharedFolder) {
			const folder = plugin.vault.getFolderByPath(sharedFolder.path);
			if (folder) {
				plugin.app.vault.trash(folder, false);
			}
		}
		dispatch("goBack", {});
	}
</script>

<Breadcrumbs
	items={[
		{
			type: "home",
			onClick: () => dispatch("goBack", { clear: true }),
		},
		{
			type: "folder",
			folder: sharedFolder,
		},
	]}
/>

<div style="padding: 1em; margin: 1em; background: var(--background-secondary)">
	<p style="margin: 1em; text-align: center">
		This Shared Folder is not on a Relay Server, or else you do not have
		permission to access it.
	</p>
</div>

{#if sharedFolder}
	<SettingItemHeading name="Danger zone"></SettingItemHeading>
	<SettingGroup>
		<SettingItem
			name="Delete metadata"
			description="Deletes edit history and disables change tracking."
		>
			<button
				class="mod-destructive"
				on:click={debounce(() => {
					handleDeleteMetadata();
				})}
			>
				Delete metadata
			</button>
		</SettingItem>

		<SettingItem
			name="Delete from vault"
			description="Delete the local Shared Folder and all of its contents."
		>
			<button
				class="mod-warning"
				on:click={debounce(() => {
					handleDeleteLocal();
				})}
			>
				Move to trash
			</button>
		</SettingItem>
	</SettingGroup>
{/if}
