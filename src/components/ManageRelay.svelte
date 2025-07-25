<script lang="ts">
	import SecretText from "./SecretText.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import {
		type Relay,
		type RelayInvitation,
		type RelayRole,
		type RelaySubscription,
		type RemoteSharedFolder,
	} from "src/Relay";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import Folder from "./Folder.svelte";
	import { Notice, debounce, normalizePath, setIcon } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import { derived, writable } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import { join } from "path-browserify";
	import SettingsControl from "./SettingsControl.svelte";
	import { uuidv4 } from "lib0/random";
	import Satellite from "./Satellite.svelte";
	import Lock from "./Lock.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import DiskUsage from "./DiskUsage.svelte";
	import { FolderSuggestModal } from "src/ui/FolderSuggestModal";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";

	export let relay: Relay;
	const remoteFolders = relay.folders;
	export let plugin!: Live;
	export let sharedFolders!: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;

	import { moment } from "obsidian";
	import { withFlag } from "src/flagManager";
	import { flag } from "src/flags";
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
		} else {
			return `Active for ${daysRemaining} more days`;
		}
	}

	function preventDefault(event: Event) {
		event.preventDefault();
	}

	function formatBytes(bytes: number, decimals = 2) {
		if (bytes === 0) return "0 MB";

		const k = 1024;
		const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

		const i = Math.floor(Math.log(bytes) / Math.log(k));

		return (bytes / Math.pow(k, i)).toFixed(decimals) + " " + sizes[i];
	}

	function userSort(a: RelayRole, b: RelayRole) {
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

	function handleManageSharedFolder(folder: SharedFolder, relay?: Relay) {
		if (!folder) {
			return;
		}
		dispatch("manageSharedFolder", { folder, relay, mount: false });
	}

	function selectText(event: Event) {
		const inputEl = event.target as HTMLInputElement;
		inputEl.focus();
		inputEl.select();
		navigator.clipboard
			.writeText(inputEl.value)
			.then(() => new Notice("Invite link copied"))
			.catch((err) => {});
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
			// ensure folder exists in vault
			if (plugin.vault.getFolderByPath(normalizedPath) === null) {
				await plugin.vault.createFolder(normalizedPath);
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
</script>

<Breadcrumbs
	category={Satellite}
	categoryText="Relay Servers"
	on:goBack={goBack}
>
	{#if relay.name}
		{relay.name}
	{:else}
		<span class="faint">(Untitled Relay Server)</span>
	{/if}
</Breadcrumbs>
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
	{#if $sharedFolders.find((local) => local.remote === remote)}
		<SlimSettingItem>
			<Folder
				on:manageSharedFolder
				folder={$sharedFolders.find((local) => local.remote === remote)}
				slot="name">{remote.name}</Folder
			>
			<SettingsControl
				on:settings={debounce(() => {
					const local = $sharedFolders.find((local) => local.remote === remote);
					if (local) {
						handleManageSharedFolder(local, remote.relay);
					}
				})}
			></SettingsControl>
		</SlimSettingItem>
	{:else}
		<SlimSettingItem>
			<Folder slot="name">{remote.name}</Folder>
			<button
				class="mod-cta"
				aria-label="Add shared folder to vault"
				on:click={debounce(() => {
					showAddToVaultModal(remote);
				})}
				style="max-width: 8em"
			>
				Add to Vault
			</button>
		</SlimSettingItem>
	{/if}
{/each}

<SettingItem description="" name="">
	<button
		class="mod-cta"
		aria-label="Select a folder to share it with this Relay Server"
		on:click={debounce(() => {
			folderSelect.open();
		})}>Share a folder</button
	>
</SettingItem>

<SettingItemHeading name="Users"
	>{$roles.values().length} / {$relay.userLimit}</SettingItemHeading
>

{#each $roles.values().sort(userSort) as item}
	<AccountSettingItem user={item.user}>
		{#if item.role === "Member" && $relay.owner}
			<button
				class="mod-destructive"
				on:click={debounce(() => {
					handleKick(item);
				})}
			>
				Kick
			</button>
		{/if}
	</AccountSettingItem>
{/each}

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
{:else}
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
		color: var(--text-faint);
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
</style>
