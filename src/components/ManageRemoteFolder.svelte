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
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import { debounce } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import { derived, writable } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import AccountSettingItem from "./AccountSettingItem.svelte";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import { curryLog } from "src/debug";
	import { normalizePath } from "obsidian";
	import { join } from "path-browserify";
	import type { SyncFlags, SyncSettingsManager } from "src/SyncSettings";

	import Lock from "./Lock.svelte";
	import { flags } from "src/flagManager";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import { Check, Edit } from "lucide-svelte";
	import { UserSelectModal } from "src/ui/UserSelectModal";
	export let plugin: Live;
	export let remoteFolder: RemoteSharedFolder;
	export let sharedFolders: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;
	export let folderRoles: ObservableMap<string, FolderRole>;

	export let errorLog = curryLog("ManageRemoveFolder.svelte", "error");

	let relayStore = derived([relayRoles], ([$relayRoles]) => {
		return $relayRoles.find((role) => role.relay === $remoteFolder.relay)
			?.relay;
	});

	let folderStore = derived($sharedFolders, ($sharedFolders) => {
		return $sharedFolders.find((folder) => folder.guid === remoteFolder.guid);
	});

	// Get folder roles for this specific folder
	let virtualFolderRoles = derived(
		[folderRoles, relayRoles],
		([$folderRoles, $relayRoles]) => {
			if ($remoteFolder.private || false) {
				return $folderRoles.filter((role) => {
					return (
						role.sharedFolderId === $remoteFolder.id &&
						$relayRoles.some((rr) => rr.userId === role.userId)
					);
				});
			}
			return relayRoles.filter((role) => {
				return role.relayId === $remoteFolder.relayId;
			});
		},
	);

	let isEditingUsers = writable(false);
	let nameValid = writable(true);
	let nameInput: HTMLInputElement;
	let updating = writable(false);
	// Track current display name for breadcrumbs (shows what user is typing)
	let currentDisplayName = $remoteFolder.name || "";

	// Create a reactive variable for the private flag to ensure breadcrumbs update
	$: isPrivate = $remoteFolder?.private || false;

	onMount(() => {
		if (nameInput && nameInput.value === "") {
			nameInput.focus();
		}
	});

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

	let syncSettings: SyncSettingsManager | undefined =
		$folderStore?.syncSettingsManager;

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
	$: settingEntries = syncSettings
		? (Object.entries(syncSettings.getCategories()) as CategoryEntry[])
		: [];

	let isUpdating = false;
	async function handleToggle(name: keyof SyncFlags, value: boolean) {
		if (isUpdating) return;
		if ($noStorage) return;
		if (!syncSettings) return;
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

	const dispatch = createEventDispatcher();

	function handleManageRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("manageRelay", { relay });
	}

	async function handleDeleteMetadata() {
		if ($folderStore) {
			plugin.sharedFolders.delete($folderStore);
		}
		dispatch("goBack", { clear: true });
	}

	function handleDeleteLocal() {
		if ($folderStore) {
			const folder = plugin.vault.getFolderByPath($folderStore.path);
			if (folder) {
				plugin.app.vault.trash(folder, false);
			}
		}
	}

	async function handleDeleteRemote() {
		try {
			await plugin.relayManager.deleteRemote(remoteFolder);
			if ($folderStore) {
				$folderStore.remote = undefined;
				plugin.sharedFolders.notifyListeners();
				dispatch("manageSharedFolder", { folder: $folderStore });
				return;
			}
		} catch (error) {
			errorLog("Failed to delete remote folder:", error);
		}
		dispatch("goBack", {});
	}

	function handleEditUsersToggle(event: KeyboardEvent | MouseEvent) {
		if (
			event instanceof MouseEvent ||
			(event instanceof KeyboardEvent &&
				(event.key === "Enter" || event.key === " "))
		) {
			isEditingUsers.update((value) => !value);
		}
	}

	async function handleRemoveFolderUser(folderRole: FolderRole) {
		await plugin.relayManager.removeFolderRole(folderRole);
	}

	async function handleMakePrivate() {
		// Make the folder private
		const updated = await plugin.relayManager.updateFolderPrivacy(
			remoteFolder,
			true,
		);
		// Update the local remoteFolder to trigger reactivity
		remoteFolder = updated;
		// Open the add users modal
		handleAddUser();
	}

	function handleAddUser() {
		const modal = new UserSelectModal(
			plugin.app,
			plugin.relayManager,
			remoteFolder,
			async (userIds: string[], role) => {
				// Add all selected users
				for (const userId of userIds) {
					await plugin.relayManager.addFolderRole(remoteFolder, userId, role);
				}
			},
		);
		modal.open();
	}

	async function handleFolderRoleChange(folderRole: FolderRole, newRole: Role) {
		await plugin.relayManager.updateFolderRole(folderRole, newRole);
	}

	async function handleFolderRoleChangeEvent(event: Event) {
		const target = event.target as HTMLSelectElement;
		const folderRole = $virtualFolderRoles.get(target.dataset.roleId!);
		if (folderRole) {
			const originalRole = folderRole.role;
			try {
				await handleFolderRoleChange(folderRole, target.value as Role);
			} catch (e) {
				// Revert dropdown to the original role value
				target.value = originalRole;
			}
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
			dispatch("manageRemoteFolder", { remoteFolder });
			return folder;
		}
		new AddToVaultModal(
			plugin.app,
			plugin.sharedFolders,
			remoteFolder,
			[],
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
			const pb = plugin.loginManager.pb;
			if (pb && $remoteFolder.id) {
				const updated = await pb
					.collection("shared_folders")
					.update($remoteFolder.id, {
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
			type: "home",
			onClick: () => dispatch("goBack", { clear: true }),
		},
		{
			type: "relay",
			relay: $remoteFolder.relay,
			onClick: () => handleManageRelay($remoteFolder.relay),
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

{#if $remoteFolder.owner}
	<SettingItem
		name="Name"
		description="Set the Shared Folder's default name. A Shared Folder can always be renamed locally."
	>
		<input
			type="text"
			spellcheck="false"
			placeholder="Example: Shared Notes"
			bind:value={$remoteFolder.name}
			bind:this={nameInput}
			on:input={handleNameChange}
			class={($updating ? "system3-updating" : "") +
				($nameValid ? "" : " system3-input-invalid")}
		/>
	</SettingItem>
{/if}

{#if !$folderStore}
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

{#if $relayStore}
	<SettingItemHeading
		name="Users with access"
		helpText={isPrivate
			? ""
			: "This folder is accessible to everyone on this Relay Server."}
	>
		{#if $remoteFolder.private && $remoteFolder.owner}
			<div
				class="edit-members-button"
				role="button"
				tabindex="0"
				aria-label={$isEditingUsers ? "Cancel editing users" : "Edit users"}
				on:click={handleEditUsersToggle}
				on:keypress={handleEditUsersToggle}
			>
				{#if $isEditingUsers}
					<Check class="svg-icon" />
				{:else}
					<Edit class="svg-icon" />
				{/if}
			</div>
		{/if}
	</SettingItemHeading>

	{#each $virtualFolderRoles.values() as role}
		<AccountSettingItem user={role.user}>
			{#if isPrivate}
				{#if $isEditingUsers}
					{#if role.userId !== plugin.relayManager.user?.id}
						<button
							class="mod-destructive"
							on:click={debounce(() => {
								if ("sharedFolder" in role) {
									handleRemoveFolderUser(role);
								}
							})}
						>
							Remove
						</button>
					{/if}
				{:else if $remoteFolder.owner}
					<div style="display: flex; gap: 8px; align-items: center;">
						<select
							class="dropdown"
							disabled={role.userId === plugin.relayManager.user?.id}
							aria-label={role.userId === plugin.relayManager.user?.id
								? "Cannot modify your own role"
								: undefined}
							value={role.role}
							data-role-id={role.id}
							on:change={handleFolderRoleChangeEvent}
						>
							<option value="Owner">Owner</option>
							<option value="Member">Member</option>
						</select>
					</div>
				{:else}
					<span class="role-label">{role.role}</span>
				{/if}
			{/if}
		</AccountSettingItem>
	{/each}

	{#if isPrivate}
		<SettingItem description="" name="">
			<button
				class="mod-cta"
				aria-label="Add user to private folder"
				disabled={$isEditingUsers}
				on:click={debounce(handleAddUser)}
			>
				Add User
			</button>
		</SettingItem>
	{/if}
{/if}
{#if $folderStore && $syncSettings && $relayStore && flags().enableAttachmentSync}
	<div class="local-settings">
		<SettingItemHeading
			name="Sync settings for this device"
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
	</div>
{/if}

<div class="spacer"></div>
{#if $remoteFolder.owner || $folderStore}
	<SettingItemHeading name="Danger zone"></SettingItemHeading>
{/if}
{#if $relayStore}
	{#if $remoteFolder.owner}
		{#if !remoteFolder?.private && remoteFolder?.relay.version > 0}
			<SettingItem
				name="Make private"
				description="Convert this folder to a private folder and manage access"
			>
				<button class="mod-destructive" on:click={debounce(handleMakePrivate)}>
					Make private
				</button>
			</SettingItem>
		{/if}
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

{#if $folderStore}
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
{/if}

<style>
	div.spacer {
		height: 3em;
	}
	.local-settings {
		margin-left: -1em;
		padding-left: 1em;
		border-left: 1px solid var(--color-accent);
	}
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
