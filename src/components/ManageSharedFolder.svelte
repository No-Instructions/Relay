<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { type Relay, type RelayRole } from "../Relay";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import { debounce } from "obsidian";
	import { createEventDispatcher, onDestroy, onMount } from "svelte";
	import { derived, writable } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import Lock from "./Lock.svelte";
	import Folder from "./Folder.svelte";
	import Satellite from "./Satellite.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import SettingsControl from "./SettingsControl.svelte";
	import { flags } from "src/flagManager";
	import { SyncSettingsManager, type SyncFlags } from "src/SyncSettings";

	export let plugin: Live;
	export let sharedFolder: SharedFolder;
	export let sharedFolders: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;

	async function handleUpgrade(relay: Relay) {
		if (!plugin.loginManager?.user) {
			return;
		}
		const payload = {
			relay: relay.id,
			quantity: 10,
			user_email: plugin.loginManager.user.email,
		};
		const encodedPayload = btoa(JSON.stringify(payload))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		window.open(
			plugin.buildApiUrl(`/subscribe/${encodedPayload}?action="buy_storage"`),
			"_blank",
		);
	}

	let folderStore = derived($sharedFolders, ($sharedFolders) => {
		return $sharedFolders.find((folder) => folder === sharedFolder);
	});

	let syncSettings: SyncSettingsManager = sharedFolder.syncSettingsManager;
	let relayStore = derived(
		[folderStore, relayRoles],
		([$folderStore, $relayRoles]) => {
			return $relayRoles.find(
				(role) => role.relay === $folderStore?.remote?.relay,
			)?.relay;
		},
	);

	let noStorage = derived(
		[folderStore, relayRoles],
		([$folderStore, $relayRoles]) => {
			return (
				$relayRoles.find((role) => role.relay === $folderStore?.remote?.relay)
					?.relay?.storageQuota?.quota === 0
			);
		},
	);

	// Type the entries
	type CategoryEntry = [
		keyof SyncFlags,
		{ name: string; description: string; enabled: boolean },
	];
	$: settingEntries = Object.entries(
		syncSettings.getCategories(),
	) as CategoryEntry[];

	let isUpdating = false;
	async function handleToggle(name: keyof SyncFlags, value: boolean) {
		if (isUpdating) return;
		if ($noStorage) return;
		isUpdating = true;
		try {
			await syncSettings.toggleCategory(name, value);
			settingEntries = Object.entries(
				syncSettings.getCategories(),
			) as CategoryEntry[];
		} catch (error) {
			// pass
		} finally {
			isUpdating = false;
		}
	}

	let nameInput: HTMLInputElement;
	onMount(() => {
		if (!sharedFolder && nameInput && nameInput.value === "") {
			nameInput.focus();
		}
	});

	const dispatch = createEventDispatcher();

	async function goBack() {
		dispatch("goBack", { clear: true });
	}

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

<Breadcrumbs category={Folder} categoryText="Shared Folders" on:goBack={goBack}>
	{sharedFolder.name}
</Breadcrumbs>

<SettingItemHeading name="Relay Server"></SettingItemHeading>
{#if $relayStore}
	<SlimSettingItem>
		<Satellite slot="name" on:manageRelay relay={$relayStore}
			>{$relayStore.name}</Satellite
		>
		<SettingsControl
			on:settings={debounce(() => {
				handleManageRelay($relayStore);
			})}
		></SettingsControl>
	</SlimSettingItem>
{:else}
	<SettingItem
		description="This folder is tracking edits, but is not connected to a Relay Server."
	/>
{/if}

{#if $relayStore && flags().enableAttachmentSync}
	<SettingItemHeading
		name="Sync settings"
		helpText="You must have attachment storage available in order to sync attachments."
	></SettingItemHeading>
	{#each settingEntries as [name, category]}
		<SlimSettingItem name={category.name} description={category.description}>
			<div class="setting-item-control">
				{#if $noStorage}
					<Lock />
				{/if}
				<div
					role="checkbox"
					aria-checked={$syncSettings[name] && !$noStorage}
					tabindex="0"
					on:keypress={() => handleToggle(name, !$syncSettings[name])}
					class="checkbox-container"
					class:is-enabled={$syncSettings[name] && !$noStorage}
					on:click={() => handleToggle(name, !$syncSettings[name])}
				>
					<input
						type="checkbox"
						checked={$syncSettings[name] && !$noStorage}
						disabled={isUpdating}
						on:change={(e) => handleToggle(name, e.currentTarget.checked)}
					/>
					<div class="checkbox-toggle"></div>
				</div>
			</div>
		</SlimSettingItem>
	{/each}
	{#if $noStorage && $relayStore}
		<SlimSettingItem name="">
			<button
				class="mod-cta"
				on:click={debounce(() => {
					handleUpgrade($relayStore);
				})}
			>
				Buy storage
			</button>
		</SlimSettingItem>
	{/if}
{/if}

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
			<button class="mod-destructive" on:click={debounce(handleDeleteRemote)}>
				Delete remote
			</button>
		</SettingItem>
	{/if}
{/if}
