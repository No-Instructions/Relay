<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { type Relay, type RelayRole } from "../Relay";
	import SettingItem from "./SettingItem.svelte";
	import store from "../Store";
	import type Live from "src/main";
	import type { SharedFolder } from "src/SharedFolder";
	import MountRelay from "./JoinRelay.svelte";
	import { Notice, debounce } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import { writable } from "svelte/store";

	export let relay: Relay;

	let plugin: Live;
	let folder: SharedFolder | undefined;

	let relayRoles: RelayRole[] = [];

	export let mount: boolean;

	const dispatch = createEventDispatcher();

	function handleManageRelay(ws: Relay) {
		console.log("manageRelayHood", relay, ws);
		relay = ws;
		mount = false;
	}

	let relay_invitation_key: string;

	store.plugin.subscribe(async (p) => {
		plugin = p;
		if (relay.id !== undefined) {
			folder = plugin.sharedFolders.find(
				(folder) => folder.guid === relay.guid,
			);
			if (folder) {
				relay.path = folder.path;
				relay.folder = folder;
			}
			relayRoles = plugin.relayManager.relayRoles.filter(
				(role) => role.relay?.id === relay.id,
			);
			relay_invitation_key =
				await plugin.relayManager.getRelayInvitationKey(relay);
		}
	});

	function handleMountRelay() {
		mount = true;
		dispatch("manageRelay", { relay, mount: true });
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

	function handleNameChange() {
		updating.set(true);
		updateRelay();
	}

	function handleUnlink() {
		relay = plugin.relayManager.unmountRelay(relay);
		//folder =
		//	relay.folder ||
		//	plugin.sharedFolders.find(
		//		(folder) => folder.id === relay.id,
		//	);
		//if (folder) {
		//	relay = plugin.workspaceManager.unmountRelay(workspace);
		//}
	}

	function handleTransfer() {
		console.log("Transfer Ownership");
	}

	function handleClose() {
		console.log("close inner");
		dispatch("close", {});
	}

	function handleDelete() {
		if (relay.path === undefined) {
			return;
		}
		const folder = plugin.vault.getFolderByPath(relay.path);
		if (folder) {
			plugin.app.vault.trash(folder, false);
		}
		relay = plugin.relayManager.unmountRelay(relay);
	}

	function handleDestroy() {
		console.log("destroying relay");
		relay = plugin.relayManager.unmountRelay(relay);
		plugin.relayManager.destroyRelay(relay);
		dispatch("goBack", {});
	}

	function selectText(event: Event) {
		console.log(event);
		const inputEl = event.target as HTMLInputElement;
		inputEl.focus();
		inputEl.select();
		navigator.clipboard
			.writeText(inputEl.value)
			.then(() => new Notice("Invite Link Copied"))
			.catch((err) => console.error("Failed to copy text: ", err));
	}
</script>

{#if mount}
	<MountRelay
		on:manageRelay={() => handleManageRelay(relay)}
		on:close={handleClose}
		{relay}
	></MountRelay>
{:else}
	{#if relay.owner}
		<SettingItemHeading name="Relay Settings"></SettingItemHeading>
		<SettingItem name="Relay Name" description="Set the Relay Name">
			<input
				type="text"
				spellcheck="false"
				placeholder="Example: Shared Notes"
				bind:value={relay.name}
				on:input={handleNameChange}
				class={$updating ? "system3-updating" : ""}
			/>
		</SettingItem>
		<SettingItem
			name="System3 for Teams"
			description="You are currently on the free plan (limited to 2 Users)"
		>
			<button class="mod-cta"> Upgrade </button>
		</SettingItem>
	{:else}
		<h3>{relay.name}</h3>
	{/if}
	<SettingItemHeading name="Status"></SettingItemHeading>
	{#if relay.folder !== undefined}
		<SettingItem name="Folder" description={relay.path || ""}></SettingItem>
	{:else}
		<SettingItem
			name="Join"
			description="Join the relay to start collaborating."
			><button class="mod-cta" on:click={handleMountRelay}>Join</button
			></SettingItem
		>
	{/if}

	<h3>Collaboration</h3>
	<SettingItemHeading name="Users"></SettingItemHeading>
	{#each relayRoles as item}
		<SettingItem name={item.user.name} description={item.role}>
			{#if item.role === "Member" && relay.owner}
				<button> Remove </button>
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
	{#if relay.owner}
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

	<h3 class="system3-settings-danger-zone">Danger Zone</h3>
	<SettingItemHeading name="Data Management"></SettingItemHeading>
	{#if relay.folder}
		<SettingItem
			name="Disconnect"
			description="This will disconnect your local folder from the relay (keeping all contents)."
		>
			<button class="mod-warning" on:click={handleUnlink}>
				Disconnect
			</button>
		</SettingItem>

		<SettingItem
			name="Delete Local Folder"
			description="Deletes your local data."
		>
			<button class="mod-warning" on:click={handleDelete}>
				Delete
			</button>
		</SettingItem>
	{:else}
		<SettingItem
			name="Disconnect"
			description="You are not connected to the relay"
		>
			<button disabled> Disconnect </button>
		</SettingItem>

		<SettingItem
			name="Delete Folder"
			description="You are not connected to the relay"
		>
			<button disabled> Delete </button>
		</SettingItem>
	{/if}

	{#if relay.owner}
		<SettingItemHeading name="Relay Management"></SettingItemHeading>
		<SettingItem
			name="Destroy Relay"
			description="This will destroy the relay and delete all data on it. All sharing will stop."
		>
			<button class="mod-warning" on:click={handleDestroy}>
				Destroy
			</button>
		</SettingItem>
		<!--SettingItem
			name="Transfer Ownership"
			description="Transfer ownership to another user."
		>
			<button class="mod-warning" on:click={handleTransfer}>
				Transfer
			</button>
		</SettingItem-->
	{/if}
{/if}

<style>
	.system3-settings-danger-zone {
		margin-top: 6em;
	}

	.system3-updating {
		border: 1px solid var(--color-accent);
	}
</style>
