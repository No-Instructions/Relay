<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { type Relay, type RelayRole } from "../Relay";
	import SettingItem from "./SettingItem.svelte";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import { debounce } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import { derived } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import Folder from "./Folder.svelte";
	import { Satellite } from "lucide-svelte";
	import SettingsControl from "./SettingsControl.svelte";

	export let plugin: Live;
	export let sharedFolder: SharedFolder;
	export let sharedFolders: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;

	let folderStore = derived($sharedFolders, ($sharedFolders) => {
		return $sharedFolders.find((folder) => folder === sharedFolder);
	});

	let relayStore = derived(
		[folderStore, relayRoles],
		([$folderStore, $relayRoles]) => {
			return $relayRoles.find(
				(role) => role.relay === $folderStore?.remote?.relay,
			)?.relay;
		},
	);

	let nameInput: HTMLInputElement;
	onMount(() => {
		if (!sharedFolder && nameInput && nameInput.value === "") {
			nameInput.focus();
		}
	});

	const dispatch = createEventDispatcher();

	function handleManageRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("manageRelay", { relay });
	}

	async function handleDeleteRemote() {
		await plugin.relayManager.deleteRemote(sharedFolder);
		plugin.sharedFolders.notifyListeners();
	}

	async function handleDeleteMetadata() {
		if ($folderStore) {
			plugin.sharedFolders.delete($folderStore);
		}
		dispatch("goBack", { clear: true });
	}

	function handleDeleteLocal() {
		const folder = plugin.vault.getFolderByPath(sharedFolder.path);
		if (folder) {
			plugin.app.vault.trash(folder, false);
		}
		dispatch("goBack", {});
	}
</script>

<h3><Folder folder={sharedFolder} /></h3>
<SettingItemHeading name="Local folder"></SettingItemHeading>
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
		Delete local
	</button>
</SettingItem>

<SettingItem
	name="Delete metadata"
	description="Deletes edit history and disables change tracking."
>
	<button
		class={$relayStore ? "mod-disabled" : "mod-warning"}
		disabled={$relayStore ? true : false}
		aria-label={$relayStore ? "Metadata is required for sharing." : ""}
		on:click={debounce(() => {
			handleDeleteMetadata();
		})}
	>
		Delete metadata
	</button>
</SettingItem>

{#if $relayStore}
	{#if $relayStore?.owner || $folderStore?.remote?.creator?.id === plugin.relayManager.user?.id}
		<SettingItemHeading name="Remote Folder"></SettingItemHeading>
		<SettingItem
			name="Remove from relay"
			description={`Deletes the remote folder from the relay. Local files will be preserved.`}
		>
			<button
				class="mod-destructive"
				on:click={debounce(handleDeleteRemote)}
			>
				Delete remote
			</button>
		</SettingItem>
	{/if}
{/if}

<SettingItemHeading name="Relay"></SettingItemHeading>
{#if $relayStore}
	<SettingItem description="">
		<span slot="name" style="display: inline-flex"
			><Satellite class="svg-icon" />{$relayStore.name}
		</span>
		<SettingsControl
			on:settings={debounce(() => {
				handleManageRelay($relayStore);
			})}
		></SettingsControl>
	</SettingItem>
{/if}
