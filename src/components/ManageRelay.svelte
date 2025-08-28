<script lang="ts">
	import SecretText from "./SecretText.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import {
		type Relay,
		type RelayInvitation,
		type RelayRole,
		type RelaySubscription,
		type RemoteSharedFolder,
		type Role,
		type FolderRole,
	} from "src/Relay";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import RemoteFolder from "./RemoteFolder.svelte";
	import { Notice, debounce, normalizePath, setIcon } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import { derived, writable } from "svelte/store";
	import { Edit, Check } from "lucide-svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import { join } from "path-browserify";
	import SettingsControl from "./SettingsControl.svelte";
	import { uuidv4 } from "lib0/random";
	import Satellite from "./Satellite.svelte";
	import Lock from "./Lock.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import DiskUsage from "./DiskUsage.svelte";
	import { FolderSuggestModal } from "src/ui/FolderSuggestModal";
	import { ShareFolderModal } from "src/ui/ShareFolderModal";
	import { FolderCreateModal } from "src/ui/FolderCreateModal";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";

	export let relay: Relay;
	const remoteFolders = relay.folders;
	export let plugin!: Live;
	export let sharedFolders!: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;
	export let folderRoles: ObservableMap<string, FolderRole>;

	import { moment } from "obsidian";
	import AccountSettingItem from "./AccountSettingItem.svelte";
	import { minimark } from "src/minimark";

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

	// Filter folders available for device sync (both local and available to add)
	const deviceSyncFolders = derived(
		[remoteFolders, folderRoles, sharedFolders],
		([$remoteFolders, $folderRoles, $sharedFolders]) => {
			const currentUserId = plugin.relayManager.user?.id;
			if (!currentUserId) return [];

			return $remoteFolders.values().filter((remoteFolder) => {
				// Apply permission logic to determine if user can access this folder
				if (!remoteFolder.private) return true;
				if (remoteFolder.creator?.id === currentUserId) return true;

				const userHasRole = $folderRoles
					.values()
					.some(
						(role) =>
							role.sharedFolderId === remoteFolder.id &&
							role.userId === currentUserId,
					);

				return userHasRole;
			});
		},
	);

	// Filter folders that user can admin (for Folder Admin section)
	const adminableFolders = derived(
		[remoteFolders, folderRoles],
		([$remoteFolders, $folderRoles]) => {
			const currentUserId = plugin.relayManager.user?.id;
			if (!currentUserId) return [];

			return $remoteFolders.values().filter((remoteFolder) => {
				// User can admin ONLY if they are the creator
				if (remoteFolder.creator?.id === currentUserId) return true;

				// OR if they have Owner role for this specific folder
				const userRole = $folderRoles
					.values()
					.find(
						(role) =>
							role.sharedFolderId === remoteFolder.id &&
							role.userId === currentUserId,
					);

				return userRole?.role === "Owner";
			});
		},
	);

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
		if (relay.owner) {
			isShareKeyEnabled.set(checked);
			plugin.relayManager
				.toggleRelayInvitation(relayInvitation, $isShareKeyEnabled)
				.then((invite) => {
					isShareKeyEnabled.set(invite.enabled);
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
			relayInvitation = await plugin.relayManager
				.rotateKey(relayInvitation)
				.catch((response) => {
					if (response.status === 429) {
						new Notice("Slow down");
					}
					throw response;
				});
		}
	}

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
			relay.guid,
			true,
		);
		folder.remote = remoteFolder;
		plugin.sharedFolders.notifyListeners();
		return folder;
	}

	let updating = writable(false);

	const updateRelay = plugin.timeProvider.debounce(() => {
		plugin.relayManager.updateRelay(relay).then(() => {
			updating.set(false);
		});
	}, 500);

	const showAddToVaultModal = (remoteFolder: RemoteSharedFolder) => {
		new AddToVaultModal(
			plugin.app,
			sharedFolders,
			remoteFolder,
			[], // No other available folders since this one is pre-selected
			addToVault,
		).open();
	};

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
		plugin.relayManager.kick(relay_role);
	}

	async function handleRoleChange(relay_role: RelayRole, newRole: Role) {
		await plugin.relayManager.updateRelayRole(relay_role, newRole);
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

	function handleManageSharedFolder(folder: SharedFolder, relay?: Relay) {
		if (!folder) {
			return;
		}
		dispatch("manageSharedFolder", { folder, relay, mount: false });
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

	function handleShareExistingFolder() {
		const modal = new ShareFolderModal(
			plugin.app,
			relay,
			sharedFolders,
			plugin.relayManager,
			async (folderPath, folderName, isPrivate, userIds) => {
				const normalizedPath = normalizePath(folderPath);
				let folder = sharedFolders.find(
					(folder) => folder.path == normalizedPath,
				);

				// If folder doesn't exist as shared folder yet, create it
				if (!folder) {
					const guid = uuidv4();
					folder = sharedFolders.new(normalizedPath, guid, relay.guid, true);
				}

				// Create remote folder with privacy settings
				const remote = await plugin.relayManager.createRemoteFolder(
					folder,
					relay,
					isPrivate,
				);

				// Add users to the private folder if it's private
				if (isPrivate) {
					for (const userId of userIds) {
						await plugin.relayManager.addFolderRole(remote, userId, "Member");
					}
				}

				folder.remote = remote;
				folder.connect();
				plugin.sharedFolders.notifyListeners();

				// Navigate to the remote folder after successful creation
				setTimeout(() => {
					dispatch("manageSharedFolder", {
						remoteFolder: remote,
						relay: remote.relay,
					});
				}, 100);

				return folder;
			},
		);
		modal.open();
	}

	const folderSelect: FolderSuggestModal = new FolderSuggestModal(
		plugin.app,
		sharedFolders,
		async (path: string) => {
			const normalizedPath = normalizePath(path);
			const folder = sharedFolders.find((folder) => folder.path == path);
			// shared folder exists, but remote does not
			if (folder) {
				const remote = await plugin.relayManager.createRemoteFolder(
					folder,
					relay,
				);
				folder.remote = remote;
				folder.connect();
				plugin.sharedFolders.notifyListeners();
				return;
			}

			// create new shared folder
			const guid = uuidv4();
			const sharedFolder = plugin.sharedFolders.new(
				normalizePath(path),
				guid,
				relay.guid,
				true,
			);

			// create remote folder
			const remote = await plugin.relayManager.createRemoteFolder(
				sharedFolder,
				relay,
			);
			sharedFolder.remote = remote;
			plugin.sharedFolders.notifyListeners();
		},
	);

	function openFolderCreateModal() {
		const modal = new FolderCreateModal(
			plugin.app,
			sharedFolders,
			plugin.relayManager,
			relay,
			() => {
				// Refresh the component after successful creation
				plugin.sharedFolders.notifyListeners();
			},
		);
		modal.open();
	}
</script>

<Breadcrumbs
	items={[
		{
			type: "text",
			text: "Relay Servers",
			onClick: () => dispatch("goBack", { clear: true })
		},
		{
			type: "satellite",
			relay: relay
		}
	]}
/>
{#if relay.owner}
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
{#each $remoteFolders.values() as remote}
	<SlimSettingItem>
		<RemoteFolder remoteFolder={remote} slot="name" on:manageRemoteFolder={() => {
			dispatch("manageRemoteFolder", {
				remoteFolder: remote,
			});
		}}
			>{remote.name}</RemoteFolder
		>
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
			handleShareExistingFolder();
		})}>Share a folder</button
	>
</SettingItem>

<div class="users-header">
	<SettingItemHeading name="Users">
		{#if $relay.owner}
			<div
				class="edit-members-button"
				role="button"
				tabindex="0"
				aria-label={$isEditingMembers
					? "Cancel editing members"
					: "Edit members"}
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
		{#if $relay.owner}
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
						<option value="Owner">Owner</option>
						<option value="Member">Member</option>
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

<SlimSettingItem name={relay.owner ? "Enable key sharing" : "Key sharing"}>
	<fragment slot="description">
		{#if relay.owner}
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
		{#if !relay.owner}
			<Lock />
		{/if}
		<div
			role="checkbox"
			aria-checked={$isShareKeyEnabled}
			tabindex="0"
			on:keypress={() => handleKeyToggle(!$isShareKeyEnabled)}
			class={relay.owner
				? "checkbox-container"
				: "checkbox-container checkbox-locked"}
			class:is-enabled={$isShareKeyEnabled}
			on:click={() => handleKeyToggle(!$isShareKeyEnabled)}
		>
			<input
				type="checkbox"
				checked={$isShareKeyEnabled}
				disabled={!relay.owner}
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

	{#if relay.owner}
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
{#if $relay.owner}
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
		<SlimSettingItem name="Name">
			{relay.provider.name}
		</SlimSettingItem>
		<SlimSettingItem name="Domain">
			{relay.provider.url}
		</SlimSettingItem>
		{#if relay.provider.selfHosted}
			{#await checkRelayHost(relay) then response}
				{#if response.level === "warning"}
					<SlimSettingItem>
						<div slot="name" class="mod-warning relay-host-warning">
							{@html minimark(response.status)}
						</div>
						{#if response.link}
							<a href={response.link.url}>
								{@html minimark(response.link.text)}
							</a>
						{/if}
					</SlimSettingItem>
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

{#if $relay.owner}
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

	.relay-host-warning {
		text-align: left;
	}
</style>
