<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { type Relay, type RelayRole } from "../Relay";
	import store from "../Store";
	import type Live from "src/main";
	import { Satellite } from "lucide-svelte";

	export let plugin: Live;
	export let relayRoles: RelayRole[];
	export let relays: Relay[];
	store.plugin.subscribe((p) => {
		plugin = p;
	});

	let shareKey = "";
	let invalidShareKey = false;

	const makeDescription = (relayRole: RelayRole) => {
		const relay = relayRole.relay;
		if (!relay) {
			return `Role: ${relayRole.role}\nUser Limit: 2`;
		}
		return `Role: ${relay.role}\nUser Limit: ${relay.user_limit}\nPath: ${relay.path}`;
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
				dispatch("joinRelay", { relay, mount: true });
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
	name="Create & Manage Relays"
	description={relays
		? "Create your own relay and invite collaborators"
		: "Manage relays"}
></SettingItemHeading>
{#each relayRoles as relayRole}
	<SettingItem
		name={relayRole.relay?.name || "..."}
		description={makeDescription(relayRole)}
	>
		{#if relayRole.relay !== undefined}
			<button on:click={() => handleManageRelay(relayRole.relay)}>
				Manage
			</button>
			{#if relayRole.relay?.folder}
				<button on:click={() => handleLeaveRelay(relayRole.relay)}>
					Disconnect
				</button>
			{:else}
				<button on:click={() => handleJoinRelay(relayRole.relay)}>
					Connect
				</button>
			{/if}
		{/if}
	</SettingItem>
{/each}

<SettingItem name="" description="">
	<button class="mod-cta" on:click={() => handleCreateRelay()}
		>Create Relay</button
	>
</SettingItem>

<style>
	input.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}
</style>
