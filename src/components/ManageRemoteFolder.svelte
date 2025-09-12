<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import {
		type Relay,
		type RelayRole,
		type FolderRole,
		type RemoteSharedFolder,
		type Role,
	} from "../Relay";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import { debounce } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import { derived, writable } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import Satellite from "./Satellite.svelte";
	import RemoteFolder from "./RemoteFolder.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import SettingsControl from "./SettingsControl.svelte";
	import AccountSettingItem from "./AccountSettingItem.svelte";
	import { Edit, Check } from "lucide-svelte";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import { curryLog } from "src/debug";
	import { normalizePath } from "obsidian";
	import { join } from "path-browserify";

	export let plugin: Live;
	export let remoteFolder: RemoteSharedFolder;
	export let sharedFolders: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;
	export let folderRoles: ObservableMap<string, FolderRole>;

	export let errorLog = curryLog("ManageRemoveFolder.svelte", "error");

	// Find the local folder if it exists
	$: localFolder = $sharedFolders.find((f) => f.remote?.id === remoteFolder.id);

	let folderStore = derived($sharedFolders, ($sharedFolders) => {
		return $sharedFolders.find(
			(folder) => folder.remote?.id === remoteFolder.id,
		);
	});

	let relayStore = derived([relayRoles], ([$relayRoles]) => {
		return $relayRoles.find((role) => role.relay === remoteFolder.relay)?.relay;
	});

	// Get folder roles for this specific folder
	let currentFolderRoles = derived(
		[folderRoles, relayRoles],
		([$folderRoles, $relayRoles]) => {
			return $folderRoles.filter((role) => {
				return (
					role.sharedFolderId === remoteFolder.id &&
					$relayRoles.some((rr) => rr.userId === role.userId)
				);
			});
		},
	);

	// Check if current user can edit the folder name
	let folderAdmin = writable(false);
	$: {
		const currentUserId = plugin.relayManager.user?.id;
		if (!currentUserId) {
			folderAdmin.set(false);
		} else {
			const isRelayOwner = $relayStore?.owner === true;
			const createdPublicFolder =
				!remoteFolder.private && remoteFolder.creator.id === currentUserId;

			// Check if user has Owner role for this specific folder
			const userFolderRole = $currentFolderRoles
				.values()
				.find((role) => role.userId === currentUserId);
			const isFolderOwner = userFolderRole?.role === "Owner";

			folderAdmin.set(isRelayOwner || isFolderOwner || createdPublicFolder);
		}
	}

	let nameValid = writable(true);
	let nameInput: HTMLInputElement;
	let updating = writable(false);
	// Track current display name for breadcrumbs (shows what user is typing)
	let currentDisplayName = remoteFolder.name || "";

	// Create a reactive variable for the private flag to ensure breadcrumbs update
	$: isPrivate = remoteFolder?.private || false;

	onMount(() => {
		if (nameInput && nameInput.value === "") {
			nameInput.focus();
		}
	});

	const dispatch = createEventDispatcher();

	async function goBack() {
		dispatch("goBack", {});
	}

	function handleManageRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("manageRelay", { relay });
	}

	async function handleDeleteRemote() {
		try {
			// If there's a local folder, use it to delete the remote
			if (localFolder) {
				await plugin.relayManager.deleteRemote(localFolder);
				plugin.sharedFolders.notifyListeners();
			} else {
				// If no local folder, delete directly via the API
				// This requires the pocketbase collection delete call
				const pb = plugin.relayManager.pb;
				if (pb && remoteFolder.id) {
					await pb.collection("shared_folders").delete(remoteFolder.id);
				}
			}

			// Navigate back to the relay page after successful deletion
			goBack();
		} catch (error) {
			errorLog("Failed to delete remote folder:", error);
			// Could show an error notification here if needed
		}
	}

	async function handleAddToVault() {
		async function addToVault(
			remoteFolder: RemoteSharedFolder,
			name: string,
			location: string,
		): Promise<SharedFolder> {
			const vaultRelativePath = normalizePath(join(location, name));
			if (plugin.vault.getFolderByPath(vaultRelativePath) === null) {
				await plugin.vault.createFolder(vaultRelativePath);
			}
			const folder = plugin.sharedFolders.new(
				vaultRelativePath,
				remoteFolder.guid,
				remoteFolder.relay.guid,
				true,
			);
			folder.remote = remoteFolder;
			plugin.sharedFolders.notifyListeners();
			dispatch("manageSharedFolder", { folder });
			return folder;
		}
		new AddToVaultModal(
			plugin.app,
			plugin.sharedFolders,
			remoteFolder,
			[], // No other available folders since this one is pre-selected
			addToVault,
		).open();
	}

	function isValidObsidianFolderName(path: string): boolean {
		// Obsidian restricted characters in folder and file names
		const restrictedCharacters = /[\\:*?"<>|]/;

		// Check if the path contains any restricted characters
		if (restrictedCharacters.test(path)) {
			return false;
		}

		// Check for any segment of the path being empty or only '.'
		const segments = path.split("/");
		for (const segment of segments) {
			if (segment === "" || segment === "." || segment === "..") {
				return false;
			}
		}
		return true;
	}

	const updateRemoteFolder = plugin.timeProvider.debounce(async () => {
		try {
			// Use PocketBase directly to update the folder name
			const pb = plugin.relayManager.pb;
			if (pb && remoteFolder.id) {
				const updated = await pb
					.collection("shared_folders")
					.update(remoteFolder.id, {
						name: nameInput.value.trim(),
					});
				// Update the local remoteFolder object to reflect changes
				if (updated) {
					remoteFolder.update(updated);
					currentDisplayName = updated.name;
				}
			}
			updating.set(false);
		} catch (error) {
			errorLog("Failed to update folder name:", error);
			// If it's a 400 error, mark the name as invalid
			if (error?.status === 400) {
				nameValid.set(false);
			}
			updating.set(false);
		}
	}, 500);

	function handleNameChange() {
		currentDisplayName = nameInput.value;
		nameValid.set(isValidObsidianFolderName(nameInput.value));
		if ($nameValid && nameInput.value !== "") {
			updating.set(true);
			updateRemoteFolder();
		}
	}
</script>

<Breadcrumbs
	items={[
		{
			type: "satellite",
			relay: remoteFolder?.relay,
			onClick: () => handleManageRelay(remoteFolder?.relay),
		},
		{
			type: "remoteFolder",
			remoteFolder: {
				...remoteFolder,
				name: currentDisplayName,
				private: isPrivate,
			},
		},
	]}
/>

{#if $folderAdmin}
	<SettingItem name="Name" description="Set the folder's name.">
		<input
			type="text"
			spellcheck="false"
			placeholder="Example: Shared Notes"
			bind:value={remoteFolder.name}
			bind:this={nameInput}
			on:input={handleNameChange}
			class={($updating ? "system3-updating" : "") +
				($nameValid ? "" : " system3-input-invalid")}
		/>
	</SettingItem>
{/if}

{#if localFolder}
	<SettingItemHeading name="My vault"></SettingItemHeading>
	<SettingItem
		name="Manage on this device"
		description="Configure sync settings and local storage for this folder"
	>
		<button
			class="mod-cta"
			on:click={() => {
				dispatch("manageSharedFolder", { folder: localFolder });
			}}
		>
			Device Settings
		</button>
	</SettingItem>
{:else}
	<SettingItemHeading name="Add to vault"></SettingItemHeading>
	<SettingItem
		name="Add this folder to your vault"
		description="Download and sync this folder to your local device"
	>
		<button class="mod-cta" on:click={debounce(handleAddToVault)}>
			Add to vault
		</button>
	</SettingItem>
{/if}

{#if $relayStore && remoteFolder?.private && $folderAdmin}
	<SettingItemHeading name="Users with access"></SettingItemHeading>

	{#each $currentFolderRoles.values() as folderRole}
		<AccountSettingItem user={folderRole.user}>
			<div style="display: flex; gap: 8px; align-items: center;">
				<select
					class="dropdown"
					disabled={true}
					aria-label={folderRole.userId === plugin.relayManager.user?.id
						? "Cannot modify your own role"
						: undefined}
					value={folderRole.role}
					data-role-id={folderRole.id}
				>
					<option value="Owner">Owner</option>
					<option value="Member">Member</option>
				</select>
			</div>
		</AccountSettingItem>
	{/each}
{/if}

{#if $relayStore}
	{#if $folderAdmin}
		<SettingItemHeading name="Danger zone"></SettingItemHeading>
		<SettingItem
			name="Remove from Relay Server"
			description={`Deletes the remote folder from the Relay Server. Local files will be preserved.`}
		>
			<button class="mod-destructive" on:click={debounce(handleDeleteRemote)}>
				Delete from Relay Server
			</button>
		</SettingItem>
	{/if}
{/if}

<style>
	.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}

	input.system3-updating {
		border: 1px solid var(--color-accent) !important;
	}

	.edit-members-button {
		display: flex;
		cursor: pointer;
		padding: 4px;
		margin-bottom: -4px;
		border-radius: var(--radius-s);
		color: var(--icon-color);
		transition:
			color 0.15s ease-in-out,
			background-color 0.15s ease-in-out;
	}

	.edit-members-button:hover {
		color: var(--icon-color-hover);
		background-color: var(--background-modifier-hover);
	}

	.edit-members-button:focus {
		outline: none;
		color: var(--icon-color-focus);
	}

	/* Fix for invisible text in disabled dropdown */
	select.dropdown:disabled {
		opacity: 1 !important;
		color: var(--text-muted) !important;
		-webkit-text-fill-color: var(--text-muted) !important;
	}
</style>
