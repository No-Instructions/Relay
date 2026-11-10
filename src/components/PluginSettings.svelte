<script lang="ts">
	import LoggedIn from "./LoggedIn.svelte";
	import Relays from "./Relays.svelte";
	import MobileRemoteFolders from "./MobileRemoteFolders.svelte";
	import ManageRelay from "./ManageRelay.svelte";
	import { type Relay } from "../Relay";
	import ModalSettingsNav from "./ModalSettingsNav.svelte";
	import type Live from "src/main";
	import type { SharedFolder } from "src/SharedFolder";
	import ManageSharedFolder from "./ManageSharedFolder.svelte";
	import ManageRemoteFolder from "./ManageRemoteFolder.svelte";
	import type { RemoteSharedFolder } from "src/Relay";
	import ToastManager from "./ToastManager.svelte";
	import { handleServerError } from "../utils/toastStore";
	import { Platform } from "obsidian";
	import { onMount } from "svelte";
	import Announcement from "./Announcement.svelte";
	import {
		type HistoryBackTarget,
		wrapHistoryBack,
	} from "../ui/settingsHistoryBack";

	interface RelayEventDetail {
		relay: Relay;
	}

	interface ScrollPosition {
		top: number;
	}

	interface View {
		scroll: ScrollPosition;
		currentRelay?: Relay;
		sharedFolder?: SharedFolder;
		remoteFolder?: RemoteSharedFolder;
		component:
			| typeof Relays
			| typeof MobileRemoteFolders
			| typeof ManageRelay
			| typeof ManageSharedFolder
			| typeof ManageRemoteFolder;
	}

	interface SharedFolderEventDetail {
		folder?: SharedFolder;
		remoteFolder?: RemoteSharedFolder;
		relay?: Relay;
	}
	interface ManageRelayEvent extends CustomEvent<RelayEventDetail> {}
	interface ManageSharedFolderEvent extends CustomEvent<SharedFolderEventDetail> {}
	interface GoBackEvent extends CustomEvent {
		clear?: boolean;
	}
	interface CreateRelayEvent extends CustomEvent {}
	interface CloseEvent extends CustomEvent {}
	interface JoinRelayEvent extends CustomEvent<RelayEventDetail> {}

	export let plugin: Live;
	export let path: string | undefined = undefined;
	const app = plugin.app;
	const relayManager = plugin.relayManager;
	const relayRoles = relayManager.relayRoles;
	const relays = relayManager.relays;
	const subscriptions = relayManager.subscriptions;
	const providers = relayManager.providers;
	const sharedFolders = plugin.sharedFolders;
	let sharedFolder: SharedFolder | undefined;

	let currentComponent:
		| typeof Relays
		| typeof MobileRemoteFolders
		| typeof ManageRelay
		| typeof ManageSharedFolder
		| typeof ManageRemoteFolder = Relays;

	let currentRelay: Relay | undefined;
	let remoteFolder: RemoteSharedFolder | undefined;
	let scroll: ScrollPosition = { top: 0 };
	let contentEl: HTMLDivElement;
	const history: View[] = [{ component: Relays, scroll }];

	function saveView() {
		scroll.top = contentEl?.scrollTop ?? 0;
		history.push({
			currentRelay,
			sharedFolder,
			remoteFolder,
			component: currentComponent,
			scroll,
		});
		scroll = { top: 0 };
	}

	function restoreScroll(element: HTMLDivElement, position: ScrollPosition) {
		element.scrollTop = position.top;
	}

	export let close: () => void;

	// function getPath(): string {
	// 	if (sharedFolder) {
	// 		const relayParam = currentRelay ? `&relay=${currentRelay.guid}` : "";
	// 		return `/shared-folders?id=${sharedFolder.guid}${relayParam}`;
	// 	}
	// 	if (currentRelay) {
	// 		return `/relays?id=${currentRelay.guid}`;
	// 	}
	// 	return "/";
	// }

	function setPath(path: string) {
		scroll = { top: 0 };
		currentRelay = undefined;
		sharedFolder = undefined;
		remoteFolder = undefined;

		if (path === "/") {
			currentComponent = Relays;
			return;
		}

		const urlParams = new URLSearchParams(path.split("?")[1] || "");
		const id = urlParams.get("id");

		if (path.startsWith("/relays")) {
			if (id) {
				currentRelay = relayManager.relays.find(
					(relay) => relay.guid === id || relay.id === id,
				);
				currentComponent = ManageRelay;
			} else {
				currentComponent = Relays;
			}
			return;
		}

		if (path.startsWith("/shared-folders")) {
			if (id) {
				sharedFolder = sharedFolders.find((f) => f.guid === id);
				const relayId = urlParams.get("relay");
				if (relayId) {
					currentRelay = relayManager.relays.find(
						(relay) => relay.guid === relayId || relay.id === relayId,
					);
				}
				if (sharedFolder?.remote) {
					remoteFolder = sharedFolder.remote;
					currentRelay = sharedFolder.remote.relay;
					currentComponent = ManageRemoteFolder;
				} else {
					currentComponent = ManageSharedFolder;
				}
			}
			return;
		}
	}

	$: {
		if (path) {
			setPath(path);
		}
	}

	function handleManageRelayEvent(event: ManageRelayEvent) {
		saveView();
		currentRelay = event.detail.relay;
		sharedFolder = undefined;
		remoteFolder = undefined;
		currentComponent = ManageRelay;
	}
	function handleManageSharedFolderEvent(event: ManageSharedFolderEvent) {
		saveView();
		sharedFolder = event.detail.folder;
		remoteFolder = event.detail.remoteFolder;
		currentRelay = event.detail.relay;
		currentComponent = ManageSharedFolder;
	}

	function handleManageRemoteFolderEvent(event: ManageSharedFolderEvent) {
		saveView();
		sharedFolder = undefined; // No local folder
		remoteFolder = event.detail.remoteFolder;
		currentRelay = event.detail.relay;
		currentComponent = ManageRemoteFolder;
	}

	async function handleCreateRelayEvent(event: CreateRelayEvent) {
		try {
			const relay = await plugin.relayManager.createRelay("");
			saveView();
			currentRelay = relay;
			currentComponent = ManageRelay;
		} catch (error: any) {
			handleServerError(error, "Failed to create relay");
		}
	}

	function handleAddRemoteFolder() {
		saveView();
		currentRelay = undefined;
		sharedFolder = undefined;
		remoteFolder = undefined;
		currentComponent = MobileRemoteFolders;
	}

	$: atRoot = !currentRelay && !sharedFolder && !remoteFolder && currentComponent !== MobileRemoteFolders;

	// Obsidian's settings modal is the window's history handler while it is
	// open: its header back arrow and the mobile hardware back button both
	// call its onHistoryBack, which on phones leaves this tab for the settings
	// list. While this view is mounted, back steps through Relay's own view
	// history first and hands over to Obsidian only from the root view.
	onMount(() => {
		const setting = (
			app as typeof app & { setting?: Partial<HistoryBackTarget> }
		).setting;
		if (!setting || typeof setting.onHistoryBack !== "function") {
			return;
		}
		return wrapHistoryBack(setting as HistoryBackTarget, (next) => {
			if (atRoot) {
				next();
				return;
			}
			goBack();
		});
	});

	function handleGoBack(event: GoBackEvent) {
		goBack(Boolean(event.detail?.clear));
	}

	function goBack(clear = false) {
		if (clear) {
			history.length = 0;
			currentRelay = undefined;
			sharedFolder = undefined;
			remoteFolder = undefined;
			currentComponent = Relays;
			scroll = { top: 0 };
			return;
		}

		let view = history.pop();
		if (view) {
			while (view) {
				if (!view.currentRelay && !view.sharedFolder && !view.remoteFolder) {
					currentRelay = view.currentRelay;
					sharedFolder = view.sharedFolder;
					remoteFolder = view.remoteFolder;
					currentComponent = view.component;
					scroll = view.scroll;
					break;
				} else if (view.sharedFolder && sharedFolders.has(view.sharedFolder)) {
					currentRelay = view.currentRelay;
					sharedFolder = view.sharedFolder;
					remoteFolder = view.remoteFolder;
					currentComponent = view.component;
					scroll = view.scroll;
					break;
				} else if (view.remoteFolder) {
					currentRelay = view.currentRelay;
					sharedFolder = view.sharedFolder;
					remoteFolder = view.remoteFolder;
					currentComponent = view.component;
					scroll = view.scroll;
					break;
				} else if (
					view.currentRelay &&
					relayManager.relays.get(view.currentRelay.id)
				) {
					currentRelay = view.currentRelay;
					sharedFolder = view.sharedFolder;
					remoteFolder = view.remoteFolder;
					currentComponent = view.component;
					scroll = view.scroll;
					break;
				}
				view = history.pop();
			}
		} else {
			scroll = { top: 0 };
			currentRelay = undefined;
			sharedFolder = undefined;
			remoteFolder = undefined;
			currentComponent = Relays;
		}
	}

	function handleClose(event: CloseEvent) {
		history.length = 0;
		close();
	}

	function handleJoinRelay(event: JoinRelayEvent) {
		scroll = { top: 0 };
		currentRelay = event.detail.relay;
		currentComponent = ManageRelay;
	}

	$: {
		if (currentRelay && !$relays.has(currentRelay.id)) {
			scroll = { top: 0 };
			currentRelay = undefined;
			currentComponent = Relays;
		}
	}

	$: {
		if (sharedFolder && !sharedFolders.has(sharedFolder)) {
			scroll = { top: 0 };
			sharedFolder = undefined;
			remoteFolder = undefined;
			currentComponent = Relays;
		}
	}
</script>

<div class="relay-settings">
	<!-- On phones the settings header overlays the top of the tab and its own
	     back arrow drives this view's history, so Relay's chevron bar would
	     only sit hidden beneath it. -->
	{#if !atRoot && !Platform.isPhone}
		<ModalSettingsNav on:goBack={handleGoBack}></ModalSettingsNav>
	{:else if atRoot && !Platform.isMobile}
		<Announcement {plugin} />
	{/if}
	{#key scroll}
		<div class="vertical-tab-content" bind:this={contentEl} use:restoreScroll={scroll}>
			{#if remoteFolder}
				<ManageRemoteFolder
					{plugin}
					{remoteFolder}
					{sharedFolders}
					{relayRoles}
					folderRoles={relayManager.folderRoles}
					on:goBack={handleGoBack}
					on:close={handleClose}
					on:manageRelay={handleManageRelayEvent}
					on:manageSharedFolder={handleManageSharedFolderEvent}
				></ManageRemoteFolder>
			{:else if sharedFolder}
				<ManageSharedFolder
					{plugin}
					{sharedFolder}
					on:goBack={handleGoBack}
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
					on:manageSharedFolder={handleManageSharedFolderEvent}
					on:manageRemoteFolder={handleManageRemoteFolderEvent}
				></ManageRelay>
			{:else if currentComponent === MobileRemoteFolders}
				<MobileRemoteFolders {plugin} on:manageRelay={handleManageRelayEvent} on:manageRemoteFolder={handleManageRemoteFolderEvent} />
			{:else}
				<LoggedIn {plugin}>
					<Relays
						{relays}
						{subscriptions}
						{providers}
						{plugin}
						on:manageRelay={handleManageRelayEvent}
						on:manageSharedFolder={handleManageSharedFolderEvent}
						on:manageRemoteFolder={handleManageRemoteFolderEvent}
						on:createRelay={handleCreateRelayEvent}
						on:joinRelay={handleJoinRelay}
						on:addRemoteFolder={handleAddRemoteFolder}
					></Relays>
				</LoggedIn>
			{/if}
		</div>
	{/key}

	<ToastManager />

	{#if plugin.manifest.version !== plugin.version}
		<span class="relay-version">
			{plugin.version}
		</span>
	{/if}
</div>

<style>
	:global(.modal.mod-settings:has(.relay-settings) > .modal-close-button) {
		z-index: 1;
	}

	.relay-settings {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		position: relative;
	}

	.relay-version {
		user-select: auto;
		background: var(--color-base-10);
		color: var(--text-faint);
		position: absolute;
		bottom: 0;
		right: 0;
		font-size: xx-small;
		padding-right: 1em;
		padding-top: 0.3em;
		padding-left: 1em;
		border-top-left-radius: 1em;
	}
	.vertical-tab-content {
		flex: 1 1 auto;
		height: auto;
		min-height: 0;
		position: relative;
	}
</style>
