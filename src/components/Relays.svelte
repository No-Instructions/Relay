<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import SettingsControl from "./SettingsControl.svelte";
	import ExternalLink from "./ExternalLink.svelte";
	import {
		hasPermissionParents,
		type Provider,
		type Relay,
		type RelaySubscription,
		type RemoteSharedFolder,
	} from "../Relay";
	import type Live from "src/main";
	import Satellite from "./Satellite.svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import type { SharedFolder } from "src/SharedFolder";
	import SharedFolderSpan from "./SharedFolderSpan.svelte";
	import { debounce, Notice } from "obsidian";
	import SecretText from "./SecretText.svelte";
	import { flags } from "src/flagManager";
	import { moment } from "obsidian";
	import { AddToVaultModal } from "src/ui/AddToVaultModal";
	import { normalizePath } from "obsidian";
	import { join } from "path-browserify";

	export let plugin: Live;
	export let relays: ObservableMap<string, Relay>;
	export let subscriptions: ObservableMap<string, RelaySubscription>;

	const sharedFolders = plugin.sharedFolders;

	let shareKey = "";
	let invalidShareKey = false;
	let invitePending = false;

	const dispatch = createEventDispatcher();

	function handleManageRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("manageRelay", { relay });
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

	function handleManageSharedFolder(folder: SharedFolder, relay?: Relay) {
		if (!folder) {
			return;
		}
		dispatch("manageSharedFolder", { folder, relay });
	}

	function handleManageRemoteFolder(remoteFolder?: RemoteSharedFolder) {
		if (!remoteFolder) {
			return;
		}
		dispatch("manageRemoteFolder", { remoteFolder });
	}

	function handleShareKeyInput() {
		invalidShareKey = false;
	}

	async function handleJoinRelayFromInvite(shareKey: string) {
		try {
			invitePending = true;
			const relay = await plugin.relayManager
				.acceptInvitation(shareKey)
				.catch((response) => {
					if (response.status === 429) {
						new Notice("Slow down");
					}
					throw response;
				});
			invitePending = false;
			dispatch("joinRelay", { relay });
		} catch (e) {
			invalidShareKey = true;
			invitePending = false;
		}
	}

	function handleCreateRelay() {
		dispatch("createRelay");
	}

	async function addFolderToVault(
		remoteFolder: RemoteSharedFolder,
		folderName: string,
		folderLocation: string,
	): Promise<SharedFolder> {
		// Create the folder path
		const vaultRelativePath = normalizePath(join(folderLocation, folderName));
		if (plugin.app.vault.getFolderByPath(vaultRelativePath) === null) {
			await plugin.app.vault.createFolder(vaultRelativePath);
		}

		// Add the folder to SharedFolders
		const folder = plugin.sharedFolders.new(
			vaultRelativePath,
			remoteFolder.guid,
			remoteFolder.relay.guid,
		);

		// Set the remote connection to ensure proper relay association
		folder.remote = remoteFolder;

		return folder;
	}

	function handleAddFolder() {
		// Get all available remote folders that aren't already in vault
		const availableFolders: RemoteSharedFolder[] = [];

		$relays.values().forEach((relay) => {
			if (relay.folders) {
				relay.folders.values().forEach((remoteFolder) => {
					// Check if folder isn't already in vault
					const alreadyInVault = $sharedFolders
						.items()
						.some((local) => local.remote?.id === remoteFolder.id);

					if (!alreadyInVault) {
						availableFolders.push(remoteFolder);
					}
				});
			}
		});

		const modal = new AddToVaultModal(
			plugin.app,
			plugin.sharedFolders,
			undefined, // No pre-selected remote folder
			availableFolders,
			addFolderToVault,
		);
		modal.open();
	}
	function sortFn(a: Relay, b: Relay): number {
		if (a.owner && !b.owner) {
			return -1;
		}
		if (b.owner && !a.owner) {
			return 1;
		}
		return a.name > b.name ? 1 : -1;
	}

	function folderSort(a: SharedFolder, b: SharedFolder): number {
		if (a.remote && !b.remote) {
			return -1;
		}
		if (b.remote && !a.remote) {
			return 1;
		}
		return a.name > b.name ? 1 : -1;
	}
</script>

<SettingItemHeading name="Join a Relay Server"></SettingItemHeading>
<SettingGroup>
	<SettingItem
		name="Share key"
		description="Enter the code that was shared with you."
	>
		<SecretText
			bind:value={shareKey}
			disabled={invitePending}
			placeholder="Enter share key"
			readonly={false}
			copyOnClick={false}
			on:input={handleShareKeyInput}
			on:enter={debounce(() => handleJoinRelayFromInvite(shareKey))}
			invalid={invalidShareKey}
		/>
		<button
			class="mod-cta system3-button"
			disabled={invitePending}
			on:click={debounce(() => handleJoinRelayFromInvite(shareKey))}
		>
			Join
		</button>
	</SettingItem>
</SettingGroup>

<SettingItemHeading
	helpText="A Relay Server coordinates real-time updates between collaborators. You can add collaborators and share folders on the Relay Server's settings page."
>
	<span slot="name" style="display: inline-flex; align-items: center">
		Relay Servers
	</span>
</SettingItemHeading>
<SettingGroup>
	{#each $relays.values().filter(hasPermissionParents).sort(sortFn) as relay}
		<SlimSettingItem>
			<Satellite slot="name" {relay} on:manageRelay>
				{#if relay.name}
					{relay.name}
				{:else}
					<span class="faint">(Untitled Relay Server)</span>
				{/if}
			</Satellite>
			<SettingsControl
				on:settings={() => {
					handleManageRelay(relay);
				}}
			></SettingsControl>
		</SlimSettingItem>
	{/each}
	<SettingItem description="" name="">
		<button class="mod-cta system3-button" on:click={debounce(() => handleCreateRelay())}>
			Create
		</button>
	</SettingItem>
</SettingGroup>

<SettingItemHeading
	name="My vault"
	helpText="The following Shared Folders have been added to your vault. You can see what Relay Server a Shared Folder is connected to below."
></SettingItemHeading>
<SettingGroup>
	{#if $sharedFolders.items().length === 0}
		<SettingItem
			description="No shared folders on this device. Share folders from a Relay Server's settings page to begin collaboration."
		/>
	{/if}
	{#each $sharedFolders.items().sort(folderSort) as folder}
		<SlimSettingItem>
			<SharedFolderSpan
				on:manageSharedFolder
				on:manageRemoteFolder
				on:manageRelay
				{folder}
				slot="name"
			/>
			{#if folder.remote}
				<SettingsControl
					on:settings={debounce(() => {
						handleManageRemoteFolder(folder.remote);
					})}
				></SettingsControl>
			{:else}
				<SettingsControl
					on:settings={debounce(() => {
						const relay = $relays.values().find((relay) => {
							return folder.remote?.relay.guid === relay.guid;
						});
						handleManageSharedFolder(folder, relay);
					})}
				></SettingsControl>
			{/if}
		</SlimSettingItem>
	{/each}

	<SlimSettingItem name="">
		<button
			class="mod-cta system3-button"
			aria-label="Add shared folder to vault"
			on:click={debounce(handleAddFolder)}
			style="max-width: 8em"
		>
			Add folder
		</button>
	</SlimSettingItem>
</SettingGroup>
{#if subscriptions.values().length > 0}
	<div class="spacer"></div>
	<SettingItemHeading
		name="Subscriptions"
		helpText="Subscriptions are tied to each Relay Server, not to your user account. Modify and cancel your subscription via our payment processor Stripe."
	></SettingItemHeading>
	<SettingGroup>
		{#each $subscriptions.values() as subscription}
			<SlimSettingItem
				name=""
				description={subscription.cancelAt
					? getActiveForMessage(subscription.cancelAt)
					: ""}
			>
				<Satellite slot="name" relay={subscription.relay} on:manageRelay>
					{#if subscription.relay.name}
						{subscription.relay.name}
					{:else}
						<span class="faint">(Untitled Relay Server)</span>
					{/if}
				</Satellite>
				<button
					class="mod-cta system3-button"
					on:click={debounce(async () => {
						if (!subscription.token) {
							const token =
								await plugin.relayManager.getSubscriptionToken(subscription);
							subscription.token = token;
						}
						const sub_id = subscription.id;
						const token = subscription.token;
						window.open(
							plugin.buildApiUrl(
								`/subscriptions/${sub_id}/manage?token=${token}`,
							),
							"_blank",
						);
					})}
				>
					Manage
				</button>
			</SlimSettingItem>
		{/each}
	</SettingGroup>
{/if}

<style>
	span.faint {
		color: var(--text-faint);
	}
	div.spacer {
		height: 3em;
	}
</style>
