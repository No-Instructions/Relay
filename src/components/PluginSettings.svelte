<script lang="ts">
	import LoggedIn from "./LoggedIn.svelte";
	import Relays from "./Relays.svelte";
	import ManageRelay from "./ManageRelay.svelte";
	import { type Relay } from "../Relay";
	import ModalSettingsNav from "./ModalSettingsNav.svelte";
	import type Live from "src/main";
	import store from "../Store";

	interface RelayEventDetail {
		relay: Relay;
		mount: boolean;
	}
	interface ManageRelayEvent extends CustomEvent<RelayEventDetail> {}
	interface GoBackEvent extends CustomEvent {}
	interface CreateRelayEvent extends CustomEvent {}
	interface CloseEvent extends CustomEvent {}

	interface JoinRelayEvent extends CustomEvent<RelayEventDetail> {}

	export let plugin: Live;
	store.plugin.subscribe((p) => {
		plugin = p;
	});
	let relayRoles = plugin.relayManager.relayRoles;
	let relays = plugin.relayManager.relays;

	let currentComponent: typeof Relays | typeof ManageRelay = Relays;
	let mount: boolean = false;

	let currentRelay: Relay | null = null;

	export let close: () => void;

	function handleManageRelayEvent(event: ManageRelayEvent) {
		currentRelay = event.detail.relay;
		mount = event.detail.mount;
		if (currentRelay.owner) {
			currentComponent = ManageRelay;
		} else {
			currentComponent = Relays;
		}
	}
	function handleCreateRelayEvent(event: CreateRelayEvent) {
		plugin.relayManager.createRelay("New Relay").then((relay) => {
			currentRelay = relay;
			currentComponent = ManageRelay;
		});
	}
	function handleGoBack(event: GoBackEvent) {
		currentRelay = null;
		currentComponent = Relays;
	}

	function handleClose(event: CloseEvent) {
		console.log("close");
		close();
	}

	function handleJoinRelay(event: JoinRelayEvent) {
		mount = event.detail.mount;
		currentRelay = event.detail.relay;
	}
</script>

{#if currentRelay}
	<ModalSettingsNav on:goBack={handleGoBack}></ModalSettingsNav>
{/if}
<div class="vertical-tab-content">
	{#if currentRelay}
		<ManageRelay
			relay={currentRelay}
			{mount}
			on:goBack={handleGoBack}
			on:close={handleClose}
			on:manageRelay={handleManageRelayEvent}
		></ManageRelay>
	{:else}
		<LoggedIn>
			<Relays
				relays={$relays.values()}
				{plugin}
				on:manageRelay={handleManageRelayEvent}
				on:createRelay={handleCreateRelayEvent}
				on:joinRelay={handleJoinRelay}
			></Relays>
		</LoggedIn>
	{/if}
</div>

<style>
	.vertical-tab-content {
		max-height: var(--modal-max-height);
	}
</style>
