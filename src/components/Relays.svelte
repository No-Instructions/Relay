<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { type Relay, type RelayRole } from "../Relay";
	import store from "../Store";
	import type Live from "src/main";
	import { Satellite } from "lucide-svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";

	export let plugin: Live;
	export let relays: ObservableMap<string, Relay>;
	export let relayRoles: ObservableMap<string, RelayRole>;
	store.plugin.subscribe((p) => {
		plugin = p;
	});

	let shareKey = "";
	let invalidShareKey = false;

	const makeDescription = (relay: Relay) => {
		let description = `Role: ${relay.role}`;
		return description;
	};

	const dispatch = createEventDispatcher();

	function handleManageRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("manageRelay", { relay, mount: false });
	}
	function handleJoinRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("joinRelay", { relay, mount: true });
	}
	function handleShareKeyInput() {
		invalidShareKey = false;
	}
	function handleJoinRelayFromInvite(shareKey: string) {
		plugin.relayManager
			.acceptInvitation(shareKey)
			.then((relay) => {
				dispatch("joinRelay", { relay, mount: false });
			})
			.catch((error) => {
				invalidShareKey = true;
			});
	}
	function handleLeaveRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		plugin.relayManager.unmountRelay(relay);
	}
	function handleCreateRelay() {
		dispatch("createRelay");
	}
	function handleRejectRelay(relay: Relay) {
		dispatch("rejectRelay", { relay: relay, mount: false });
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

<SettingItemHeading
	name="Join a Relay"
	description="Relays facilitate sharing by sending changes to collaborators."
	><Satellite /></SettingItemHeading
>
<SettingItem
	name="Share Key"
	description="Enter the code that was shared with you"
>
	<input
		type="text"
		placeholder="Enter Share Key"
		bind:value={shareKey}
		on:input={handleShareKeyInput}
		class={invalidShareKey ? "system3-input-invalid" : ""}
	/>
	<button class="mod-cta" on:click={() => handleJoinRelayFromInvite(shareKey)}
		>Join Relay</button
	>
</SettingItem>

<SettingItemHeading
	name="My Relays"
	description={relays
		? "Create your own relay and invite collaborators"
		: "Manage relays"}
></SettingItemHeading>
{#each $relays.values().sort(sortFn) as relay}
	{#if relay.folder && $relayRoles.some((role) => role.relay?.id === relay.id)}
		<SettingItem
			name={relay.name || "..."}
			description={makeDescription(relay)}
		>
			{#if relay.folder}
				<button
					class="mod-destructive"
					on:click={() => handleLeaveRelay(relay)}
				>
					Leave
				</button>
			{:else}
				<button on:click={() => handleJoinRelay(relay)}> Join </button>
			{/if}
			<button on:click={() => handleManageRelay(relay)}> Manage </button>
		</SettingItem>
	{/if}
{/each}

{#each $relays.values().sort(sortFn) as relay}
	{#if !relay.folder && relay.owner && $relayRoles.some((role) => role.relay?.id === relay.id)}
		<SettingItem
			name={relay.name || "..."}
			description={makeDescription(relay)}
		>
			{#if relay.folder}
				<button
					class="mod-destructive"
					on:click={() => handleLeaveRelay(relay)}
				>
					Leave
				</button>
			{:else}
				<button on:click={() => handleJoinRelay(relay)}> Join </button>
			{/if}
			<button on:click={() => handleManageRelay(relay)}> Manage </button>
		</SettingItem>
	{/if}
{/each}

<SettingItem name="" description="">
	<button class="mod-cta" on:click={() => handleCreateRelay()}
		>Create Relay</button
	>
</SettingItem>

{#if $relays.some((relay) => !relay.folder && !relay.owner && $relayRoles.some((role) => role.relay?.id === relay.id))}
	<SettingItemHeading
		name="Invites"
		description={relays
			? "Pending invitations"
			: "Type in a share key to see invitations"}
	></SettingItemHeading>
{/if}
{#each $relays.values() as relay}
	{#if !relay.folder && !relay.owner && $relayRoles.some((role) => role.relay?.id === relay.id)}
		<SettingItem
			name={relay.name || "..."}
			description={makeDescription(relay)}
		>
			<button on:click={() => handleManageRelay(relay)}> Accept </button>
			<button
				class="mod-destructive"
				on:click={() => handleRejectRelay(relay)}
			>
				Reject
			</button>
		</SettingItem>
	{/if}
{/each}

<style>
	input.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}
</style>
