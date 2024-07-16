<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import {
		type Relay,
		type RelayRole,
		type RemoteSharedFolder,
	} from "../Relay";
	import SettingItem from "./SettingItem.svelte";
	import store from "../Store";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import { Notice, debounce, normalizePath } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import { derived, readable, writable } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import Folder from "./Folder.svelte";
	import Checkbox from "./Checkbox.svelte";
	import { Satellite } from "lucide-svelte";
	import SettingsControl from "./SettingsControl.svelte";

	export let plugin: Live;
	export let sharedFolder: SharedFolder;
	export let sharedFolders: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;

	function userSort(a: RelayRole, b: RelayRole) {
		if (a.role === "Owner" && b.role !== "Owner") {
			return -1;
		}
		if (a.role !== "Owner" && b.role === "Owner") {
			return 1;
		}
		return a.user.name > b.user.name ? 1 : -1;
	}

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

	let nameValid = writable(true);
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

<!--

	<SettingItemHeading name="Access Controls"></SettingItemHeading>
	<SettingItem
		name="Private"
		description="Make the folder private for user-specific access controls."
	>
		<Checkbox
			disabled={true}
			checked={sharedFolder.remote?.private || false}
			label="Not yet implemented."
		/>
	</SettingItem>

	<SettingItemHeading name="Users"></SettingItemHeading>

	<SettingItemHeading name="Users"></SettingItemHeading>
	{#each $roles as item}
		<SettingItem name={item.user.name} description=""></SettingItem>
	{/each}

-->
<!--

    <SettingItem name="" description="">
		<button class="mod-cta" on:click={() => handleAddUser()}>
			Add User
		</button>
	</SettingItem>

	{#if $relayStore}
		<SettingItemHeading name="Sharing"></SettingItemHeading>
		<SettingItem
			name="Share Key"
			description="Share this key with your collaborators"
		>
			<input
				value={relay_invitation_key}
				type="text"
				readonly
				on:click={selectText}
				id="system3InviteLink"
			/>
		</SettingItem>
	{/if}
    -->
<!--

	{#if relay?.owner}
		<SettingItem
			name="Plan: Free"
			description="You are currently on the free plan (limited to 2 Users)"
		>
			<button
				class="mod-cta"
				on:click={() => {
					if (relay) {
						handleManageRelay(relay);
					}
				}}
			>
				Manage Relay
			</button>
		</SettingItem>
	{/if}
	-->

<SettingItemHeading name="Local Folder"></SettingItemHeading>
<SettingItem
	name="Delete from Vault"
	description="Delete the local Shared Folder and all of its contents."
>
	<button
		class="mod-warning"
		on:click={debounce(() => {
			handleDeleteLocal();
		})}
	>
		Delete Local
	</button>
</SettingItem>

<SettingItem
	name="Delete Metadata"
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
		Delete Metadata
	</button>
</SettingItem>

{#if $relayStore}
	{#if $relayStore?.owner || $folderStore?.remote?.creator?.id === plugin.relayManager.user?.id}
		<SettingItemHeading name="Remote Folder"></SettingItemHeading>
		<SettingItem
			name="Remove from Relay"
			description={`Deletes the remote folder from the Relay. Local files will be preserved.`}
		>
			<button
				class="mod-destructive"
				on:click={debounce(handleDeleteRemote)}
			>
				Delete Remote
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

<style>
	/*
	input#system3InviteLink {
		width: auto;
	}
	*/
</style>
