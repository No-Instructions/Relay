<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import {
		type Relay,
		type RelayRole,
		type RelaySubscription,
		type RemoteSharedFolder,
	} from "src/Relay";
	import type Live from "src/main";
	import { SharedFolders, type SharedFolder } from "src/SharedFolder";
	import Folder from "./Folder.svelte";
	import { Notice, debounce, normalizePath } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import { derived, writable, type Readable } from "svelte/store";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import { join } from "path-browserify";
	import SettingsControl from "./SettingsControl.svelte";
	import { uuidv4 } from "lib0/random";
	import { FolderSuggestModal } from "src/ui/FolderSuggestModal";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import SettingItem from "./SettingItem.svelte";

	export let relay: Relay;
	const remoteFolders = relay.folders;
	export let plugin!: Live;
	export let sharedFolders!: SharedFolders;
	export let relayRoles: ObservableMap<string, RelayRole>;

	import moment from "moment";
	import { FeatureFlagManager, withFlag } from "src/flagManager";
	import { flag } from "src/flags";

	function getActiveForMessage(cancelAtDate: Date | null): string {
		if (!cancelAtDate) {
			return "Active";
		}
		const now = moment();
		const cancelAt = moment(cancelAtDate);
		const daysRemaining = cancelAt.diff(now, "days");

		if (daysRemaining <= 0) {
			return "Subscription has ended";
		} else if (daysRemaining === 1) {
			return "Active for 1 more day";
		} else {
			return `Active for ${daysRemaining} more days`;
		}
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
		return $subscriptions.values()[0];
	});

	const roles = $relayRoles.filter((role: RelayRole) => {
		return role.relay?.id === relay.id;
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
		window.open(
			plugin.buildApiUrl(
				`/subscribe?relay=${relay.id}&quantity=10&user_email=${plugin.loginManager.user.name}`,
			),
			"_blank",
		);
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

	async function handleLeaveRelay() {
		plugin.relayManager.leaveRelay(relay);
		dispatch("goBack", { clear: true });
	}

	let relay_invitation_key: string;
	plugin.relayManager.getRelayInvitationKey(relay).then((key) => {
		relay_invitation_key = key;
	});

	async function addToVault(
		remoteFolder: RemoteSharedFolder,
		name: string,
		location: string,
	): Promise<SharedFolder> {
		const vaultRelativePath = normalizePath(join(location, name));
		if (plugin.vault.getFolderByPath(vaultRelativePath) === null) {
			await plugin.vault.createFolder(vaultRelativePath);
		}
		return plugin.sharedFolders
			.new(vaultRelativePath, remoteFolder.guid, relay.guid, true)
			.then((folder) => {
				folder.remote = remoteFolder;
				plugin.sharedFolders.notifyListeners();
				withFlag(flag.enableDownloadOnAddToVault, () => {
					plugin.backgroundSync.getFolderFiles(folder);
				});
				return folder;
			});
	}

	let updating = writable(false);

	const updateRelay = debounce(
		() => {
			plugin.relayManager.updateRelay(relay);
			updating.set(false);
		},
		500,
		true,
	);

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
			const sharedFolder = await plugin.sharedFolders.new(
				normalizePath(path),
				guid,
				relay.guid,
				false,
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

<h3>{relay.name}</h3>
{#if relay.owner}
	<SettingItem name="Relay name" description="Set the relay name.">
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

<SettingItemHeading name="Shared folders"></SettingItemHeading>
{#each $remoteFolders.values() as remote}
	{#if $sharedFolders.find((local) => local.remote === remote)}
		<SettingItem description=""
			><Folder folder={remote} slot="name" />
			<SettingsControl
				on:settings={debounce(() => {
					const local = $sharedFolders.find((local) => local.remote === remote);
					if (local) {
						handleManageSharedFolder(local, remote.relay);
					}
				})}
			></SettingsControl>
		</SettingItem>
	{:else}
		<SettingItem description="">
			<Folder folder={remote} slot="name" />
			<button
				class="mod-cta"
				aria-label="Add shared folder to vault"
				on:click={debounce(() => {
					showAddToVaultModal(remote);
				})}
			>
				Add to Vault
			</button>
		</SettingItem>
	{/if}
{/each}

<SettingItem description="" name="">
	<button
		class="mod-cta"
		aria-label="Select a folder to add to the relay"
		on:click={debounce(() => {
			folderSelect.open();
		})}>Add</button
	>
</SettingItem>

<SettingItemHeading name="Users"
	>{$roles.values().length} / {$relay.user_limit}</SettingItemHeading
>

{#each $roles.values().sort(userSort) as item}
	<SettingItem name={item.user.name} description={item.role}>
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
	</SettingItem>
{/each}

<!--

    <SettingItem name="" description="">
		<button class="mod-cta" on:click={() => handleAddUser()}>
			Add User
		</button>
	</SettingItem>
    -->
<SettingItemHeading name="Sharing"></SettingItemHeading>

<SettingItem
	name="Share key"
	description="Share this key with your collaborators."
>
	<input
		value={relay_invitation_key}
		type="text"
		readonly
		on:click={debounce(selectText)}
		id="system3InviteLink"
	/>
</SettingItem>
{#if $relay.owner}
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

			{#if $subscriptions.values()[0].active && !$subscriptions.values()[0].cancel_at}
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
		{#if !$subscriptions.values()[0].active || $subscriptions.values()[0].cancel_at}
			<SettingItem description="">
				<span slot="name" class="mod-warning">Status: Cancelled</span>
				{getActiveForMessage($subscriptions.values()[0].cancel_at)}
			</SettingItem>
		{/if}
	{:else}
		<SettingItem name={`Plan: ${$relay.plan}`} description="">
			<fragment slot="description">
				{$relay.cta || "Thanks for supporting Relay development <3"}
			</fragment>
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
	<SettingItemHeading name="Storage" description=""></SettingItemHeading>
	<SettingItem
		name="Destroy relay"
		description="This will destroy the relay (deleting all data on the server). Local data is preserved."
	>
		{#if $subscriptions.values().length > 0 && !$subscriptions.values()[0].cancel_at}
			<button
				disabled={true}
				class="mod-warning"
				aria-label="Cancel subscription to destroy relay."
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
	<SettingItemHeading name="Membership" description=""></SettingItemHeading>
	<SettingItem
		name="Leave relay"
		description="Leave the relay. Local data is preserved."
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
	.system3-settings-danger-zone {
		margin-top: 6em;
	}

	input.system3-updating {
		border: 1px solid var(--color-accent) !important;
	}

	input.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}
</style>
