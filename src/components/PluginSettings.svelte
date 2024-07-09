<script lang="ts">
	import LoggedIn from "./LoggedIn.svelte";
	import Relays from "./Relays.svelte";
	import ManageRelay from "./ManageRelay.svelte";
	import { type Relay } from "../Relay";
	import ModalSettingsNav from "./ModalSettingsNav.svelte";
	import type Live from "src/main";
	import type { SharedFolder } from "src/SharedFolder";
	import ManageSharedFolder from "./ManageSharedFolder.svelte";

	interface RelayEventDetail {
		relay: Relay;
	}

	interface View {
		currentRelay?: Relay;
		sharedFolder?: SharedFolder;
		component:
			| typeof Relays
			| typeof ManageRelay
			| typeof ManageSharedFolder;
	}

	interface SharedFolderEventDetail {
		folder: SharedFolder;
		relay?: Relay;
	}
	interface ManageRelayEvent extends CustomEvent<RelayEventDetail> {}
	interface ManageSharedFolderEvent
		extends CustomEvent<SharedFolderEventDetail> {}
	interface GoBackEvent extends CustomEvent {
		clear?: boolean;
	}
	interface CreateRelayEvent extends CustomEvent {}
	interface CloseEvent extends CustomEvent {}

	interface JoinRelayEvent extends CustomEvent<RelayEventDetail> {}
	interface RejectRelayEvent extends CustomEvent<RelayEventDetail> {}

	export let plugin: Live;
	const app = plugin.app;
	const relayManager = plugin.relayManager;
	const relayRoles = relayManager.relayRoles;
	const relays = relayManager.relays;
	const sharedFolders = plugin.sharedFolders;
	let sharedFolder: SharedFolder | undefined;

	let currentComponent:
		| typeof Relays
		| typeof ManageRelay
		| typeof ManageSharedFolder = Relays;

	let currentRelay: Relay | undefined;
	const history: View[] = [{ component: Relays }];

	export let close: () => void;

	function handleManageRelayEvent(event: ManageRelayEvent) {
		currentRelay = event.detail.relay;
		sharedFolder = undefined;
		if (currentRelay.owner) {
			currentComponent = ManageRelay;
		} else {
			currentComponent = Relays;
		}
		history.push({ currentRelay, component: currentComponent });
	}
	function handleManageSharedFolderEvent(event: ManageSharedFolderEvent) {
		sharedFolder = event.detail.folder;
		currentRelay = event.detail.relay;
		history.push({
			currentRelay,
			sharedFolder,
			component: ManageSharedFolder,
		});
	}

	function handleCreateRelayEvent(event: CreateRelayEvent) {
		plugin.relayManager.createRelay("").then((relay) => {
			currentRelay = relay;
			currentComponent = ManageRelay;
		});
		history.push({ currentRelay, component: ManageRelay });
	}
	function handleGoBack(event: GoBackEvent) {
		if (event.detail.clear) {
			history.length = 0;
			currentRelay = undefined;
			sharedFolder = undefined;
			currentComponent = Relays;
			return;
		}
		history.pop();
		const view = history.pop();
		if (view) {
			if (view.sharedFolder) {
				currentRelay = view.sharedFolder.remote?.relay;
			} else {
				currentRelay = view.currentRelay;
				sharedFolder = undefined;
			}
			currentComponent = view.component;
			history.push(view);
		}
	}

	function handleClose(event: CloseEvent) {
		history.length = 0;
		close();
	}

	function handleJoinRelay(event: JoinRelayEvent) {
		currentRelay = event.detail.relay;
		history.push({ currentRelay, component: ManageRelay });
	}

	function handleRejectRelay(event: RejectRelayEvent) {
		plugin.relayManager.leaveRelay(event.detail.relay);
		currentRelay = undefined;
	}
</script>

{#if currentRelay || sharedFolder}
	<ModalSettingsNav on:goBack={handleGoBack}></ModalSettingsNav>
{/if}
<div class="vertical-tab-content">
	{#if sharedFolder}
		<ManageSharedFolder
			{plugin}
			{relayRoles}
			relay={currentRelay}
			{sharedFolder}
			{sharedFolders}
			on:goBack={handleGoBack}
			on:manageRelay={handleManageRelayEvent}
			on:close={handleClose}
		></ManageSharedFolder>
	{:else if currentRelay}
		<ManageRelay
			{plugin}
			{relayRoles}
			relay={currentRelay}
			{sharedFolders}
			on:goBack={handleGoBack}
			on:close={handleClose}
			on:manageRelay={handleManageRelayEvent}
			on:manageSharedFolder={handleManageSharedFolderEvent}
			on:rejectRelay={handleRejectRelay}
		></ManageRelay>
	{:else}
		<LoggedIn {plugin}>
			<Relays
				{relays}
				{relayRoles}
				{plugin}
				on:manageRelay={handleManageRelayEvent}
				on:manageSharedFolder={handleManageSharedFolderEvent}
				on:createRelay={handleCreateRelayEvent}
				on:rejectRelay={handleRejectRelay}
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
