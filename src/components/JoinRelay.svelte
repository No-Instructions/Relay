<script lang="ts">
	import type Live from "../main";
	import path from "path-browserify";

	import store from "../Store";
	import SettingItem from "./SettingItem.svelte";

	import type { Relay } from "src/Relay";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { createEventDispatcher } from "svelte";
	import { Folder } from "lucide-svelte";
	import { normalizePath } from "obsidian";

	export let relay: Relay;

	let plugin: Live;

	store.plugin.subscribe((p) => (plugin = p));

	let folderName: string = relay.path || "-" + relay.name;
	let folderLocation: string = "";

	const dispatch = createEventDispatcher();

	function handleMount() {
		// XXX refactor
		const vaultRelativePath = normalizePath(
			path.join(folderLocation, folderName),
		);
		if (plugin.vault.getFolderByPath(vaultRelativePath) !== null) {
			plugin.sharedFolders
				.new(path.join(folderLocation, folderName), relay.guid)
				.then((sharedFolder) => {
					plugin.relayManager.mountRelay(relay, sharedFolder);
					dispatch("manageRelay", { relay });
				});
		} else {
			plugin.vault.createFolder(vaultRelativePath).then((folder) => {
				plugin.sharedFolders
					.new(path.join(folderLocation, folderName), relay.guid)
					.then((sharedFolder) => {
						plugin.relayManager.mountRelay(relay, sharedFolder);
						dispatch("manageRelay", { relay });
					});
			});
		}
	}
</script>

<SettingItemHeading name="Relay Folder" description="Folder for Relay content"
	><Folder /></SettingItemHeading
>
<SettingItem name={folderName} description="">
	<!--input
		type="text"
		spellcheck="false"
		placeholder="Example: Shared Notes"
		bind:value={folderName}
	/-->
	<!--SettingItem
	name="Folder Location"
	description=""
>
	<input
		type="text"
		spellcheck="false"
		placeholder="/"
		bind:value={folderLocation}
	/>
	<div class="search-input-container templater_search">
		<input
			enterkeyhint="search"
			type="search"
			spellcheck="false"
			placeholder="Example: folder1/folder2"
			bind:value={folderLocation}
		/>
		<div class="search-input-clear-button"></div>
	</div>
</SettingItem-->
	<button class="mod-cta" on:click={() => handleMount()}>
		{#if folderName == relay.path}
			Connect
		{:else}
			Add to Vault
		{/if}
	</button>
</SettingItem>
