<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingsControl from "./SettingsControl.svelte";
	import { type Provider, type Relay } from "../Relay";
	import type Live from "src/main";
	import Satellite from "./Satellite.svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import type { SharedFolder } from "src/SharedFolder";
	import SharedFolderSpan from "./SharedFolderSpan.svelte";
	import { debounce, Notice } from "obsidian";
	import SecretText from "./SecretText.svelte";
	import { flags } from "src/flagManager";

	export let plugin: Live;
	export let relays: ObservableMap<string, Relay>;
	export let providers: ObservableMap<string, Provider>;

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
	function handleManageSharedFolder(folder: SharedFolder, relay?: Relay) {
		if (!folder) {
			return;
		}
		dispatch("manageSharedFolder", { folder, relay });
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
	function sortFn(a: Relay, b: Relay): number {
		if (a.owner && !b.owner) {
			return -1;
		}
		if (b.owner && !a.owner) {
			return 1;
		}
		return a.name > b.name ? 1 : -1;
	}
</script>

<SettingItemHeading name="Join a Relay Server"></SettingItemHeading>
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
		class="mod-cta"
		disabled={invitePending}
		on:click={debounce(() => handleJoinRelayFromInvite(shareKey))}
	>
		Join
	</button>
</SettingItem>

<SettingItemHeading
	helpText="A Relay Server coordinates real-time updates between collaborators. You can add collaborators and share folders on the Relay Server's settings page."
>
	<span slot="name" style="display: inline-flex; align-items: center">
		Relay Servers
	</span>
</SettingItemHeading>
{#each $relays.values().sort(sortFn) as relay}
	<SlimSettingItem>
		<Satellite slot="name" {relay} on:manageRelay t="name">
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
<SettingItem name="" description="">
	<button class="mod-cta" on:click={debounce(() => handleCreateRelay())}>
		Create
	</button>
</SettingItem>

<SettingItemHeading
	name="Shared Folders"
	helpText="Shared Folders enhance local folders by tracking edits. You can see what Relay Server a Shared Folder is connected to below."
></SettingItemHeading>
{#if $sharedFolders.items().length === 0}
	<SettingItem
		description="Go to a Relay Server's settings page above to share existing folders, or add Shared Folders to your vault."
	/>
{/if}
{#each $sharedFolders.items() as folder}
	<SlimSettingItem>
		<SharedFolderSpan
			on:manageRelay
			on:manageSharedFolder
			{folder}
			relay={folder.remote?.relay}
			slot="name"
		/>
		<SettingsControl
			on:settings={debounce(() => {
				const relay = $relays.values().find((relay) => {
					return folder.remote?.relay.guid === relay.guid;
				});
				handleManageSharedFolder(folder, relay);
			})}
		></SettingsControl>
	</SlimSettingItem>
{/each}


{#if flags().enableSelfManageHosts}
	<SettingItemHeading name="Hosts" helpText="Manage self-hosted Relay Servers"
	></SettingItemHeading>
	{#if $providers.values().length === 0}
		<SettingItem
			description="See our documentation for how to host a Relay Server."
		/>
	{/if}
	{#each $providers.values() as provider}
		<SlimSettingItem name={provider?.name} description={provider?.url}
		></SlimSettingItem>
	{/each}
{/if}

<style>
	span.faint {
		color: var(--text-faint);
	}
</style>
