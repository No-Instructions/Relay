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
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import { Check, Edit } from "lucide-svelte";
	import { UserSelectModal } from "src/ui/UserSelectModal";
	import { handleServerError } from "src/utils/toastStore";
	export let plugin: Live;
	export let remoteFolder: RemoteSharedFolder;
	export let sharedFolders: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;
	export let folderRoles: ObservableMap<string, FolderRole>;

	let displayName: string = remoteFolder.name;

	export let errorLog = curryLog("ManageRemoveFolder.svelte", "error");

	plugin.relayManager.refreshRemoteFolder(remoteFolder);

	let relayStore = derived([relayRoles], ([$relayRoles]) => {
		return $relayRoles.find((role) => role.relayId === $remoteFolder.relayId)
			?.relay;
	});

	let folderStore = derived($sharedFolders, ($sharedFolders) => {
		return $sharedFolders
			.items()
			.find((folder) => folder.guid === remoteFolder.guid);
	});

	// Dynamic role loading for forwards compatibility
	const availableRoles = derived([plugin.relayManager.roles], ([$roles]) => {
		return $roles.values().sort(rolePrioritySort);
	});

	function rolePrioritySort(a: { name: Role }, b: { name: Role }) {
		const priority: Record<Role, number> = { Owner: 0, Member: 1, Reader: 2 };
		return (priority[a.name] ?? 999) - (priority[b.name] ?? 999);
	}

	// Get folder roles for this specific folder
	let virtualFolderRoles = derived(
		[folderRoles, relayRoles],
		([$folderRoles, $relayRoles]) => {
			if ($remoteFolder.private || false) {
				// Manual filtering instead of .filter() to avoid DerivedMap lifecycle issues
				const result = [];
				for (const role of $folderRoles.values()) {
					if (
						role.sharedFolderId === $remoteFolder.id &&
						$relayRoles.some((rr) => rr.userId === role.userId)
					) {
						result.push(role);
					}
				}
				return result;
			}
			// Manual filtering for relay roles too
			const result = [];
			for (const role of $relayRoles.values()) {
				if (role.relayId === $remoteFolder.relayId) {
					result.push(role);
				}
			}
			return result;
		},
	);

	let isEditingUsers = writable(false);
	let nameValid = writable(true);
	let nameInput: HTMLInputElement;
	let updating = writable(false);
	let lastSavedName = remoteFolder.name;

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

	// Permission stores - direct store subscriptions
	const canReadFolder = plugin.relayManager.userCan(
		["folder", "read_content"],
		remoteFolder,
	);
	const canRenameFolder = plugin.relayManager.userCan(
		["folder", "rename"],
		remoteFolder,
	);
	const canDeleteFolder = plugin.relayManager.userCan(
		["folder", "delete"],
		remoteFolder,
	);
	const canManageUsers = plugin.relayManager.userCan(
		["folder", "manage_users"],
		remoteFolder,
	);
	const canMakeFolderPrivate = plugin.relayManager.userCan(
		["folder", "make_private"],
		remoteFolder,
	);

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
		try {
			await plugin.relayManager.removeFolderRole(folderRole);
		} catch (error) {
			handleServerError(error, "Failed to remove user from folder.");
		}
	}

	async function handleMakePrivate() {
		try {
			// Make the folder private
			const updated = await plugin.relayManager.updateFolderPrivacy(
				remoteFolder,
				true,
			);
			// Open the add users modal
			handleAddUser();
		} catch (error) {
			handleServerError(
				error,
				"Failed to make folder private. Permission denied.",
			);
		}
	}

	function handleAddUser() {
		const modal = new UserSelectModal(
			plugin.app,
			plugin.relayManager,
			remoteFolder,
			async (userIds: string[], role) => {
				try {
					// Add all selected users
					for (const userId of userIds) {
						await plugin.relayManager.addFolderRole(remoteFolder, userId, role);
					}
				} catch (error) {
					handleServerError(error, "Failed to add users to folder.");
				}
			},
		);
		modal.open();
	}

	async function handleFolderRoleChange(folderRole: FolderRole, newRole: Role) {
		try {
			await plugin.relayManager.updateFolderRole(folderRole, newRole);
		} catch (error) {
			handleServerError(error, "Failed to change user role.");
			throw error;
		}
	}

	async function handleFolderRoleChangeEvent(event: Event) {
		const target = event.target as HTMLSelectElement;
		const folderRole = $virtualFolderRoles.find(
			(role) => role.id === target.dataset.roleId!,
		);
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

	const updateRemoteFolder = plugin.timeProvider.debounce(async (name) => {
		try {
			// Use RelayManager to update the folder name
			const updated = await plugin.relayManager.updateRemoteFolder(
				remoteFolder,
				{
					name: name,
				},
			);
			lastSavedName = updated.name;
			displayName = updated.name;
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
		nameValid.set(isValidObsidianFolderName(nameInput.value));
		const currentName = nameInput.value.trim();

		// Only update if the value has actually changed and is valid
		if ($nameValid && currentName !== "" && currentName !== lastSavedName) {
			updating.set(true);
			updateRemoteFolder(currentName);
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
				...$remoteFolder,
				name: displayName,
				private: isPrivate,
			},
		},
	]}
/>

{#if $canManageUsers && !$canReadFolder}
	<div
		style="padding: 1em; margin: 1em; background: var(--background-secondary)"
	>
		<p style="margin: 1em; text-align: center">
			As Relay Server owner, you can manage this Shared Folder but cannot access
			its contents. You must be added to the Shared Folder in order to
			collaborate.
		</p>
	</div>
{/if}

{#if $canRenameFolder}
	<SettingItem
		name="Name"
		description="Set the Shared Folder's default name. A Shared Folder can always be renamed locally."
	>
		<input
			type="text"
			spellcheck="false"
			placeholder="Example: Shared Notes"
			bind:value={displayName}
			bind:this={nameInput}
			on:input={handleNameChange}
			class={($updating ? "system3-updating" : "") +
				($nameValid ? "" : " system3-input-invalid")}
		/>
	</SettingItem>
{/if}

{#if !$folderStore && $canReadFolder}
	<SettingItemHeading name="Add to vault"></SettingItemHeading>
	<SettingGroup>
		<SettingItem
			name="Add this folder to your vault"
			description="Download and sync this folder to your local device"
		>
			<button class="mod-cta system3-button" on:click={debounce(handleAddToVault)}>
				Add to vault
			</button>
		</SettingItem>
	</SettingGroup>
{/if}

{#if $relayStore}
	<SettingItemHeading
		name="Users with access"
		helpText={isPrivate
			? ""
			: "This folder is accessible to everyone on this Relay Server."}
	>
		{#if $remoteFolder.private && $canManageUsers}
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

	<SettingGroup>
		{#each $virtualFolderRoles as role}
		<AccountSettingItem user={role.user}>
			{#if isPrivate}
				{#if $isEditingUsers}
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
				{:else if $canManageUsers}
					<div style="display: flex; gap: 8px; align-items: center;">
						<select
							class="dropdown"
							value={role.role}
							data-role-id={role.id}
							on:change={handleFolderRoleChangeEvent}
						>
							{#each $availableRoles as role}
								<option value={role.name}>{role.name}</option>
							{/each}
						</select>
					</div>
				{:else}
					<span class="role-label">{role.role}</span>
				{/if}
			{/if}
		</AccountSettingItem>
	{/each}

	{#if isPrivate && $canManageUsers}
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
	</SettingGroup>
{/if}

<div class="spacer"></div>

{#if $folderStore && $syncSettings && $relayStore}
	<div class="local-settings">
		<SettingItemHeading
			name="Sync settings for this device"
			helpText="You must have attachment storage available in order to sync attachments."
		></SettingItemHeading>

		<SettingGroup>
			{#if displayName !== $folderStore.name}
			<SettingItem
				name="Local path"
				description="This folder has a different name in your Vault"
			>
				/{$folderStore.path}
			</SettingItem>
		{/if}
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
		</SettingGroup>
	</div>
{/if}

<div class="spacer"></div>

{#if $canDeleteFolder || $canMakeFolderPrivate || $folderStore}
	<SettingItemHeading name="Danger zone"></SettingItemHeading>
	<SettingGroup>
		{#if $relayStore}
			{#if $canMakeFolderPrivate}
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
			{/if}
			{#if $canDeleteFolder}
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
	</SettingGroup>
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
