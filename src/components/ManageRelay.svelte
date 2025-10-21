<script lang="ts">
	import SecretText from "./SecretText.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import {
		hasPermissionParents,
		type Relay,
		type RelayInvitation,
		type RelayRole,
		type RelaySubscription,
		type RemoteSharedFolder,
		type Role,
	} from "src/Relay";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import RemoteFolder from "./RemoteFolder.svelte";
	import { Notice, debounce, normalizePath, setIcon } from "obsidian";
	import { createEventDispatcher, onMount, onDestroy } from "svelte";
	import { derived, writable, get } from "svelte/store";
	import { Edit, Check, Download } from "lucide-svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import { join } from "path-browserify";
	import SettingsControl from "./SettingsControl.svelte";
	import { uuidv4 } from "lib0/random";
	import Lock from "./Lock.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import DiskUsage from "./DiskUsage.svelte";
	import { ShareFolderModal } from "src/ui/ShareFolderModal";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import { FolderSuggestModal } from "src/ui/FolderSuggestModal";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";

	export let relay: Relay;
	const remoteFolders = relay.folders;
	export let plugin!: Live;
	export let sharedFolders!: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;

	import { moment } from "obsidian";
	import AccountSettingItem from "./AccountSettingItem.svelte";
	import { minimark } from "src/minimark";
	import { handleServerError } from "../utils/toastStore";

	plugin.relayManager.refreshRelay(relay);

	async function checkRelayHost(relay: Relay) {
		const response = await plugin.loginManager.checkRelayHost(relay.guid);
		if (response.status === 200) {
			return response.json;
		}
	}

	function getActiveForMessage(cancelAtDate: Date | null): string {
		if (!cancelAtDate) {
			return "Active";
		}
		const now = moment.utc();
		const cancelAt = moment.utc(cancelAtDate);
		const daysRemaining = cancelAt.diff(now, "days");

		if (daysRemaining <= 0) {
			return "Subscription has ended";
		} else if (daysRemaining === 1) {
			return "Active for 1 more day";
		} else if (daysRemaining > 31) {
			return `Ends on ${cancelAt.format("YYYY-MM-DD")}`;
		} else {
			return `Active for ${daysRemaining} more days`;
		}
	}

	function formatBytes(bytes: number, decimals = 2) {
		if (bytes === 0) return "0 MB";

		const k = 1024;
		const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

		const i = Math.floor(Math.log(bytes) / Math.log(k));

		return (bytes / Math.pow(k, i)).toFixed(decimals) + " " + sizes[i];
	}

	function userSort(a: RelayRole, b: RelayRole) {
		if (a.role === "Owner" && b.role === "Owner") {
			return a.userId === plugin.loginManager.user?.id ? -1 : 1;
		}
		if (a.role === "Owner" && b.role !== "Owner") {
			return -1;
		}
		if (a.role !== "Owner" && b.role === "Owner") {
			return 1;
		}
		return a.user.name > b.user.name ? 1 : -1;
	}

	// Dynamic role loading for forwards compatibility
	const availableRoles = derived([plugin.relayManager.roles], ([$roles]) => {
		return $roles.values().sort(rolePrioritySort);
	});

	function rolePrioritySort(a: { name: Role }, b: { name: Role }) {
		const priority: Record<Role, number> = { Owner: 0, Member: 1, Reader: 2 };
		return (priority[a.name] ?? 999) - (priority[b.name] ?? 999);
	}

	const subscriptions = $relay.subscriptions;
	const subscription = derived($subscriptions, ($subscriptions) => {
		if ($subscriptions.values().length === 0) {
			return undefined;
		}
		const subscription = $subscriptions.values()[0];
		if (!subscription.token) {
			plugin.relayManager.getSubscriptionToken(subscription).then((token) => {
				subscription.token = token;
			});
		}
		return subscription;
	});

	const storageQuota = $relay.storageQuota;

	const roles = $relayRoles.filter((role: RelayRole) => {
		return role.relayId === relay.id;
	});

	let nameValid = writable(true);
	let nameInput: HTMLInputElement;
	onMount(() => {
		if (nameInput && nameInput.value === "") {
			nameInput.focus();
		}
	});
	const dispatch = createEventDispatcher();

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
		window.open(plugin.buildApiUrl(`/subscribe/${encodedPayload}`), "_blank");
	}

	async function handleManage(subscription: RelaySubscription) {
		const token = subscription.token;
		const sub_id = subscription.id;
		window.open(
			plugin.buildApiUrl(`/subscriptions/${sub_id}/manage?token=${token}`),
			"_blank",
		);
	}

	async function handleCancel(subscription: RelaySubscription) {
		const token = subscription.token;
		const sub_id = subscription.id;
		window.open(
			plugin.buildApiUrl(`/subscriptions/${sub_id}/cancel?token=${token}`),
			"_blank",
		);
	}

	function handleKeyToggle(checked: boolean) {
		if ($canManageSharing) {
			isShareKeyEnabled.set(checked);

			plugin.relayManager
				.toggleRelayInvitation(relayInvitation, $isShareKeyEnabled)
				.then((invite) => {
					isShareKeyEnabled.set(invite.enabled);
				})
				.catch((error) => {
					// Revert the toggle state
					isShareKeyEnabled.set(!checked);
					handleServerError(error, "Failed to toggle share key");
				});
		}
	}

	async function handleLeaveRelay() {
		plugin.relayManager.leaveRelay(relay);
		dispatch("goBack", { clear: true });
	}

	async function goBack() {
		dispatch("goBack", { clear: true });
	}

	let relayInvitation: RelayInvitation;
	let isShareKeyEnabled = writable(true);
	let isEditingMembers = writable(false);
	plugin.relayManager.getRelayInvitation(relay).then((invite) => {
		if (invite) {
			relayInvitation = invite;
			isShareKeyEnabled.set(invite.enabled);
		}
	});

	async function rotateKey() {
		if (relayInvitation) {
			try {
				relayInvitation = await plugin.relayManager.rotateKey(relayInvitation);
			} catch (error) {
				handleServerError(error, "Failed to rotate key.");
			}
		}
	}

	let updating = writable(false);

	const updateRelay = plugin.timeProvider.debounce(() => {
		plugin.relayManager.updateRelay(relay).then(() => {
			updating.set(false);
		});
	}, 500);

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

	function handleNameChange() {
		nameValid.set(isValidObsidianFolderName(nameInput.value));
		if ($nameValid && nameInput.value !== "") {
			updating.set(true);
			updateRelay();
		}
	}

	function handleDestroy() {
		plugin.relayManager.destroyRelay(relay);
		dispatch("goBack", {});
	}

	function handleKick(relay_role: RelayRole) {
		plugin.relayManager.kick(relay_role).catch((error) => {
			handleServerError(error, "Failed to remove user");
		});
	}

	async function handleRoleChange(relay_role: RelayRole, newRole: Role) {
		try {
			await plugin.relayManager.updateRelayRole(relay_role, newRole);
		} catch (error) {
			handleServerError(error, "Failed to change user role.");
			throw error;
		}
	}

	async function handleRoleChangeEvent(event: Event) {
		const target = event.target as HTMLSelectElement;
		const relayRole = $roles.get(target.dataset.roleId!);
		if (relayRole) {
			const originalRole = relayRole.role;
			try {
				await handleRoleChange(relayRole, target.value as Role);
			} catch (e) {
				// Revert dropdown to the original role value
				target.value = originalRole;
			}
		}
	}

	function handleEditMembersToggle(event: KeyboardEvent | MouseEvent) {
		if (
			event instanceof MouseEvent ||
			(event instanceof KeyboardEvent &&
				(event.key === "Enter" || event.key === " "))
		) {
			isEditingMembers.update((value) => !value);
		}
	}

	// Permission stores - direct store subscriptions
	const canManageUsers = plugin.relayManager.userCan(
		["relay", "manage_users"],
		relay,
	);
	const canManageSharing = plugin.relayManager.userCan(
		["relay", "manage_sharing"],
		relay,
	);
	const canRenameRelay = plugin.relayManager.userCan(
		["relay", "rename"],
		relay,
	);
	const canDeleteRelay = plugin.relayManager.userCan(
		["relay", "delete"],
		relay,
	);
	const canManageSubscription = plugin.relayManager.userCan(
		["subscription", "manage"],
		relay,
	);

	function onChoose(folderPath: string): Promise<SharedFolder>;
	function onChoose(
		folderPath: string,
		folderName: string,
		isPrivate: boolean,
		userIds: string[],
	): Promise<SharedFolder>;
	// Implementation
	async function onChoose(
		folderPath: string,
		folderName?: string,
		isPrivate?: boolean,
		userIds?: string[],
	): Promise<SharedFolder> {
		const normalizedPath = normalizePath(folderPath);
		let folder = sharedFolders.find((folder) => folder.path == normalizedPath);

		if (plugin.vault.getFolderByPath(normalizedPath) === null) {
			await plugin.vault.createFolder(normalizedPath);
		}

		// If folder doesn't exist as shared folder yet, create it
		if (!folder) {
			const guid = uuidv4();
			folder = sharedFolders.new(normalizedPath, guid, relay.guid, true);
		}

		// Create remote folder with privacy settings
		const remote = await plugin.relayManager.createRemoteFolder(
			folder,
			relay,
			isPrivate ?? false,
			folderName,
		);

		// Add users to the private folder if it's private
		if (isPrivate && userIds && userIds.length > 0) {
			for (const userId of userIds) {
				await plugin.relayManager.addFolderRole(remote, userId, "Member");
			}
		}

		folder.remote = remote;
		folder.connect();
		plugin.sharedFolders.notifyListeners();

		if (userIds && userIds.length > 0) {
			// Navigate to the remote folder after successful creation
			setTimeout(() => {
				dispatch("manageRemoteFolder", {
					remoteFolder: remote,
				});
			}, 100);
		}
		return folder;
	}

	const shareFolderModal = new ShareFolderModal(
		plugin.app,
		relay,
		sharedFolders,
		plugin.relayManager,
		onChoose,
	);

	async function handleAddToVault(remoteFolder: RemoteSharedFolder) {
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
			dispatch("manageRemoteFolder", { remoteFolder: folder.remote });
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

	onDestroy(() => {
		shareFolderModal?.destroy();
	});
</script>

<Breadcrumbs
	items={[
		{
			type: "home",
			onClick: () => dispatch("goBack", { clear: true }),
		},
		{
			type: "relay",
			relay: relay,
		},
	]}
/>
{#if $canRenameRelay}
	<SettingItem name="Name" description="Set the Relay Server's name.">
		<input
			type="text"
			spellcheck="false"
			placeholder="Example: Shared Notes"
			bind:value={relay.name}
			bind:this={nameInput}
			on:input={handleNameChange}
			class={($updating ? "system3-updating" : "") +
				($nameValid ? "" : " system3-input-invalid")}
		/>
	</SettingItem>
{/if}

<SettingItemHeading name="Folders on this Relay Server"></SettingItemHeading>
{#each $remoteFolders.values().filter(hasPermissionParents) as remote}
	<SlimSettingItem>
		<RemoteFolder
			remoteFolder={remote}
			slot="name"
			on:manageRemoteFolder={() => {
				dispatch("manageRemoteFolder", {
					remoteFolder: remote,
				});
			}}>{remote.name}</RemoteFolder
		>
		{#if !$sharedFolders.some((sharedFolder) => sharedFolder.guid === remote.guid) && get(plugin.relayManager.userCan(["folder", "read_content"], remote))}
			<SettingsControl
				on:settings={debounce(() => {
					handleAddToVault(remote);
				})}
				label="Add to vault"
			>
				<Download
					class="svg-icon lucide-settings"
					props={{ class: "svg-icon lucide-settings" }}
				/>
			</SettingsControl>
		{/if}
		<SettingsControl
			on:settings={debounce(() => {
				dispatch("manageRemoteFolder", {
					remoteFolder: remote,
				});
			})}
		></SettingsControl>
	</SlimSettingItem>
{/each}

<SettingItem description="" name="">
	<button
		class="mod-cta"
		aria-label="Select a folder to share it with this Relay Server"
		on:click={debounce(() => {
			if (relay.version === 0) {
				// For relay version 0, go directly to folder selection
				const folderModal = new FolderSuggestModal(
					plugin.app,
					"Choose or create folder...",
					new Set(
						sharedFolders.filter((f) => !!f.relayId).map((f) => f.path),
					).add("/"),
					sharedFolders,
					onChoose,
				);
				folderModal.open();
			} else {
				// For relay version > 0, use the full modal with privacy settings
				shareFolderModal.open();
			}
		})}>Share a folder</button
	>
</SettingItem>

<div class="users-header">
	<SettingItemHeading name="Users">
		{#if $canManageUsers}
			<div
				class="edit-members-button"
				role="button"
				tabindex="0"
				aria-label={$isEditingMembers ? "Done editing" : "Edit members"}
				on:click={handleEditMembersToggle}
				on:keypress={handleEditMembersToggle}
			>
				{#if $isEditingMembers}
					<Check class="svg-icon" />
				{:else}
					<Edit class="svg-icon" />
				{/if}
			</div>
		{/if}
	</SettingItemHeading>
</div>

{#each $roles.values().sort(userSort) as item}
	<AccountSettingItem user={item.user}>
		{#if $canManageUsers}
			{#if $isEditingMembers}
				{#if item.userId !== plugin.loginManager.user?.id}
					<button
						class="mod-destructive"
						on:click={debounce(() => {
							handleKick(item);
						})}
					>
						Kick
					</button>
				{/if}
			{:else}
				<div style="display: flex; gap: 8px; align-items: center;">
					<select
						class="dropdown"
						disabled={item.userId === plugin.loginManager.user?.id}
						aria-label={item.userId === plugin.loginManager.user?.id
							? "Cannot modify your own role"
							: undefined}
						value={item.role}
						data-role-id={item.id}
						on:change={handleRoleChangeEvent}
					>
						{#each $availableRoles as role}
							<option value={role.name}>{role.name}</option>
						{/each}
					</select>
				</div>
			{/if}
		{:else}
			<span class="role-label">{item.role}</span>
		{/if}
	</AccountSettingItem>
{/each}

<SettingItem description="" name="">
	<span class="faint"
		>{$roles.values().length} of {$relay.userLimit} seats used
	</span>
</SettingItem>

<!--

    <SettingItem name="" description="">
		<button class="mod-cta" on:click={() => handleAddUser()}>
			Add User
		</button>
	</SettingItem>
    -->
<SettingItemHeading name="Sharing"></SettingItemHeading>

<SlimSettingItem
	name={$canManageSharing ? "Enable key sharing" : "Key sharing"}
>
	<fragment slot="description">
		{#if $canManageSharing}
			<div class="setting-item-description">
				Allow others to join this Relay Server with a Share Key.
			</div>
		{:else if $isShareKeyEnabled}
			<div class="setting-item-description">
				The owner of this Relay Server has enabled key sharing.
			</div>
		{:else}
			<div class="setting-item-description mod-warning">
				The owner of this Relay Server has disabled key sharing.
			</div>
		{/if}
	</fragment>
	<div class="setting-item-control">
		{#if !$canManageSharing}
			<Lock />
		{/if}
		<div
			role="checkbox"
			aria-checked={$isShareKeyEnabled}
			tabindex="0"
			on:keypress={() => handleKeyToggle(!$isShareKeyEnabled)}
			class={$canManageSharing
				? "checkbox-container"
				: "checkbox-container checkbox-locked"}
			class:is-enabled={$isShareKeyEnabled}
			on:click={() => handleKeyToggle(!$isShareKeyEnabled)}
		>
			<input
				type="checkbox"
				checked={$isShareKeyEnabled}
				disabled={!$canManageSharing}
				on:change={(e) => handleKeyToggle(e.currentTarget.checked)}
			/>
			<div class="checkbox-toggle"></div>
		</div>
	</div>
</SlimSettingItem>

{#if $isShareKeyEnabled}
	<SettingItem
		name="Share Key"
		description="Share this key with your collaborators."
	>
		<div class="share-key-container">
			{#if !$isShareKeyEnabled}
				<span
					role="button"
					tabindex="0"
					class="input-like share-key-disabled-notice"
				>
					Share key is currently disabled
				</span>
			{:else}
				<SecretText
					value={relayInvitation ? relayInvitation.key : "please wait..."}
					disabled={!$isShareKeyEnabled}
					placeholder="please wait..."
					readonly={true}
					copyOnClick={true}
					successMessage="Invite link copied"
				/>
			{/if}
		</div>
	</SettingItem>

	{#if $canManageSharing}
		<SettingItem
			name="Rotate key"
			description="Create a new share key. The old key will no longer work."
		>
			<button on:click={debounce(rotateKey)} class="mod-destructive">
				Rotate key
			</button>
		</SettingItem>
	{/if}
{/if}
{#if $canManageSubscription}
	<SettingItemHeading name="Plan" />
	{#if $subscription}
		<SettingItem name={`Plan: ${$relay.plan}`} description="">
			<fragment slot="description">
				{$relay.cta}
			</fragment>
			<button
				on:click={debounce(() => {
					handleManage($subscription);
				})}
			>
				Manage
			</button>

			{#if $subscriptions.values()[0].active && !$subscriptions.values()[0].cancelAt}
				<button
					class="mod-destructive"
					on:click={debounce(() => {
						handleCancel($subscription);
					})}
				>
					Cancel
				</button>
			{/if}
		</SettingItem>
		{#if !$subscriptions.values()[0].active || $subscriptions.values()[0].cancelAt}
			<SettingItem description="">
				<span slot="name" class="mod-warning">Status: Cancelled</span>
				{getActiveForMessage($subscriptions.values()[0].cancelAt)}
			</SettingItem>
		{/if}
	{:else}
		<SettingItem
			name={`Plan: ${$relay.plan}`}
			description={$relay.cta || "Thanks for supporting Relay development"}
		>
			<button
				class="mod-cta"
				on:click={debounce(() => {
					handleUpgrade($relay);
				})}
			>
				Upgrade
			</button>
		</SettingItem>
	{/if}
	{#if $storageQuota && $storageQuota.quota > 0}
		<SettingItemHeading name="Storage"></SettingItemHeading>
		<DiskUsage
			diskUsagePercentage={Math.round(
				($storageQuota.usage * 100) / $storageQuota.quota,
			)}
		/>
		<SlimSettingItem
			name="Usage"
			description="Storage for images, audio, video, etc"
		>
			{formatBytes($storageQuota.usage)}
		</SlimSettingItem>

		<SlimSettingItem
			name="Total storage"
			description="Total available storage."
		>
			{formatBytes($storageQuota.quota)}
		</SlimSettingItem>

		<SlimSettingItem
			name="File size limit"
			description="Maximum supported file size."
		>
			{formatBytes($storageQuota.maxFileSize)}
		</SlimSettingItem>
	{/if}

	{#if relay.provider}
		{#if relay.provider.selfHosted}
			<SettingItemHeading name="Self hosting"></SettingItemHeading>
		{:else}
			<SettingItemHeading name="Host"></SettingItemHeading>
		{/if}
		<SettingItem name="Name" description="">
			{relay.provider.name}
		</SettingItem>
		<SettingItem name="Domain" description="">
			{relay.provider.url}
		</SettingItem>
		{#if relay.provider.selfHosted}
			{#await checkRelayHost(relay) then response}
				{#if response.level === "warning"}
					<p class="mod-warning relay-host-check">
						{@html minimark(response.status)}

						{#if response.link}
							<br />
							<a href={response.link.url}>
								{@html minimark(response.link.text)}
							</a>
						{/if}
					</p>
				{/if}
			{/await}
		{/if}
	{/if}
{/if}

{#if !$relay.owner || $relayRoles
		.filter((role) => role.role === "Owner" && role.relayId === relay.id)
		.values().length > 1}
	<SettingItemHeading name="Membership"></SettingItemHeading>
	<SettingItem
		name="Leave Relay Server"
		description="Leave the Relay Server. Local data is preserved."
	>
		<button
			class="mod-warning"
			on:click={debounce(() => {
				handleLeaveRelay();
			})}
		>
			Leave
		</button>
	</SettingItem>
{/if}

{#if $canDeleteRelay}
	<SettingItemHeading name="Danger zone"></SettingItemHeading>
	<SettingItem
		name="Destroy Relay Server"
		description="This will destroy the Relay Server (deleting all data on the server). Local data is preserved."
	>
		{#if $subscriptions.values().length > 0 && !$subscriptions.values()[0].cancelAt}
			<button
				disabled={true}
				class="mod-warning"
				aria-label="Cancel subscription to destroy Relay Server."
			>
				Destroy
			</button>
		{:else}
			<button class="mod-warning" on:click={debounce(handleDestroy)}>
				Destroy
			</button>
		{/if}
	</SettingItem>
{/if}

<!--SettingItem
			name="Transfer Ownership"
			description="Transfer ownership to another user."
		>
			<button class="mod-warning" on:click={handleTransfer}>
				Transfer
			</button>
		</SettingItem-->

<style>
	.faint {
		color: var(--text-faint) !important;
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

	/* Share key styling */
	.share-key-container {
		width: 100%;
	}

	.share-key-disabled-notice {
		color: var(--text-error) !important;
		font-size: 0.85em !important;
	}

	.relay-host-check {
		text-align: right;
	}
	input.system3-updating {
		border: 1px solid var(--color-accent) !important;
	}

	input.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}
</style>
