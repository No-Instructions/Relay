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

	interface View {
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
	interface GoBackEvent extends CustomEvent<{ clear?: boolean }> {}

	export let plugin: Live;
	export let path: string | undefined = undefined;
	export let close: () => void;
	const app = plugin.app;
	const relayManager = plugin.relayManager;
	const relayRoles = relayManager.relayRoles;
	const relays = relayManager.relays;
	const remoteFolders = relayManager.remoteFolders;
	const subscriptions = relayManager.subscriptions;
	const providers = relayManager.providers;
	const sharedFolders = plugin.sharedFolders;
	let currentView: View = { component: Relays };
	let history: View[] = [];
	let desktopContentEl: HTMLDivElement | undefined;

	function activate(view: View) {
		if (!Platform.isMobile && desktopContentEl) desktopContentEl.scrollTop = 0;
		currentView = view;
	}

	function isRoot(view: View): boolean {
		return !view.currentRelay && !view.sharedFolder && !view.remoteFolder &&
			view.component !== MobileRemoteFolders;
	}

	function isAvailable(
		view: View,
		relayMap: Pick<typeof relays, "has"> = relays,
		folders: Pick<typeof sharedFolders, "has"> = sharedFolders,
		remoteMap: Pick<typeof remoteFolders, "has"> = remoteFolders,
	): boolean {
		const relay = view.currentRelay ?? view.remoteFolder?.relay;
		return (!relay || relayMap.has(relay.id)) &&
			(!view.sharedFolder || folders.has(view.sharedFolder)) &&
			(!view.remoteFolder || remoteMap.has(view.remoteFolder.id));
	}

	function navigateTo(next: View) {
		const samePage = (page: View) => page.component === next.component &&
			page.currentRelay === next.currentRelay && page.sharedFolder === next.sharedFolder &&
			page.remoteFolder === next.remoteFolder;
		if (Platform.isMobile && samePage(currentView)) return;
		const parents = history.filter((page) => isAvailable(page));
		const ancestor = Platform.isMobile ? parents.findIndex(samePage) : -1;
		if (ancestor >= 0) {
			activate(parents[ancestor]);
			history = parents.slice(0, ancestor);
		} else {
			history = isAvailable(currentView) ? [...parents, currentView] : parents;
			activate(next);
		}
	}

	function setPath(path: string) {
		const next: View = { component: Relays };
		const params = new URLSearchParams(path.split("?")[1] || "");
		const id = params.get("id");
		if (path.startsWith("/relays") && id) {
			next.currentRelay = relays.find((relay) => relay.guid === id || relay.id === id);
			next.component = ManageRelay;
		} else if (path.startsWith("/shared-folders") && id) {
			next.sharedFolder = sharedFolders.find((folder) => folder.guid === id);
			const relayId = params.get("relay");
			if (relayId) {
				next.currentRelay = relays.find((relay) => relay.guid === relayId || relay.id === relayId);
			}
			if (next.sharedFolder?.remote) {
				next.remoteFolder = next.sharedFolder.remote;
				next.currentRelay = next.remoteFolder.relay;
				next.component = ManageRemoteFolder;
			} else {
				next.component = ManageSharedFolder;
			}
		}
		const root = history.find(isRoot) ?? (isRoot(currentView) ? currentView : { component: Relays });
		history = isRoot(next) ? [] : [root];
		activate(isRoot(next) ? root : next);
	}

	$: if (path) setPath(path);

	function handleManageRelayEvent(event: ManageRelayEvent) {
		navigateTo({ component: ManageRelay, currentRelay: event.detail.relay });
	}

	function handleManageSharedFolderEvent(event: ManageSharedFolderEvent) {
		navigateTo({
			component: ManageSharedFolder,
			sharedFolder: event.detail.folder,
			remoteFolder: event.detail.remoteFolder,
			currentRelay: event.detail.relay,
		});
	}

	function handleManageRemoteFolderEvent(event: ManageSharedFolderEvent) {
		navigateTo({
			component: ManageRemoteFolder,
			remoteFolder: event.detail.remoteFolder,
			currentRelay: event.detail.relay,
		});
	}

	async function handleCreateRelayEvent() {
		const source = currentView;
		try {
			const relay = await relayManager.createRelay("");
			if (currentView === source) navigateTo({ component: ManageRelay, currentRelay: relay });
		} catch (error: any) {
			handleServerError(error, "Failed to create relay");
		}
	}

	function handleAddRemoteFolder() {
		navigateTo({ component: MobileRemoteFolders });
	}

	$: atRoot = isRoot(currentView);

	// The phone header and hardware Back button use the settings modal's
	// history handler. Leave the Relay tab only after its page stack is empty.
	onMount(() => {
		const setting = (
			app as typeof app & { setting?: Partial<HistoryBackTarget> }
		).setting;
		if (!setting || typeof setting.onHistoryBack !== "function") return;
		return wrapHistoryBack(setting as HistoryBackTarget, (next) => {
			if (atRoot) next();
			else goBack();
		});
	});

	function handleGoBack(event: GoBackEvent) {
		goBack(Boolean(event.detail?.clear));
	}

	function goBack(clear = false) {
		if (clear) {
			activate(history.find(isRoot) ?? { component: Relays });
			history = [];
			return;
		}
		const parents = history.filter((page) => isAvailable(page));
		activate(parents.pop() ?? { component: Relays });
		history = parents;
	}

	function handleClose() {
		history = [];
		close();
	}

	// Retained hidden pages can finish asynchronous work. Only the visible
	// page may initiate navigation.
	function fromPage<T>(page: View, handle: (event: T) => unknown) {
		return (event: T) => {
			if (page === currentView) handle(event);
		};
	}

	$: {
		const parents = history.filter((page) => isAvailable(page, $relays, $sharedFolders, $remoteFolders));
		if (parents.length !== history.length) history = parents;
		const relay = currentView.currentRelay ?? currentView.remoteFolder?.relay;
		if ((relay && !$relays.has(relay.id)) ||
			(currentView.sharedFolder && !$sharedFolders.has(currentView.sharedFolder))) {
			goBack();
		}
	}
</script>

{#snippet pageContent(page: View)}
	{#if page.remoteFolder}
		<ManageRemoteFolder
			{plugin}
			remoteFolder={page.remoteFolder}
			{sharedFolders}
			{relayRoles}
			folderRoles={relayManager.folderRoles}
			on:goBack={fromPage(page, handleGoBack)}
			on:close={fromPage(page, handleClose)}
			on:manageRelay={fromPage(page, handleManageRelayEvent)}
			on:manageSharedFolder={fromPage(page, handleManageSharedFolderEvent)}
		></ManageRemoteFolder>
	{:else if page.sharedFolder}
		<ManageSharedFolder
			{plugin}
			sharedFolder={page.sharedFolder}
			on:goBack={fromPage(page, handleGoBack)}
			on:close={fromPage(page, handleClose)}
		></ManageSharedFolder>
	{:else if page.currentRelay}
		<ManageRelay
			{plugin}
			{relayRoles}
			relay={page.currentRelay}
			{sharedFolders}
			on:goBack={fromPage(page, handleGoBack)}
			on:close={fromPage(page, handleClose)}
			on:manageSharedFolder={fromPage(page, handleManageSharedFolderEvent)}
			on:manageRemoteFolder={fromPage(page, handleManageRemoteFolderEvent)}
		></ManageRelay>
	{:else if page.component === MobileRemoteFolders}
		<MobileRemoteFolders {plugin} on:manageRelay={fromPage(page, handleManageRelayEvent)} on:manageRemoteFolder={fromPage(page, handleManageRemoteFolderEvent)} />
	{:else}
		<LoggedIn {plugin}>
			<Relays
				{relays}
				{subscriptions}
				{providers}
				{plugin}
				on:manageRelay={fromPage(page, handleManageRelayEvent)}
				on:manageSharedFolder={fromPage(page, handleManageSharedFolderEvent)}
				on:manageRemoteFolder={fromPage(page, handleManageRemoteFolderEvent)}
				on:createRelay={fromPage(page, handleCreateRelayEvent)}
				on:joinRelay={fromPage(page, handleManageRelayEvent)}
				on:addRemoteFolder={fromPage(page, handleAddRemoteFolder)}
			></Relays>
		</LoggedIn>
	{/if}
{/snippet}

<div class="relay-settings">
	{#if !atRoot && !Platform.isPhone}
		<ModalSettingsNav on:goBack={handleGoBack}></ModalSettingsNav>
	{:else if atRoot && !Platform.isMobile}
		<Announcement {plugin} />
	{/if}
	{#if Platform.isMobile}
		{#each [...history, currentView] as page (page)}
			<div class="vertical-tab-content relay-settings-page" hidden={page !== currentView}>
				{@render pageContent(page)}
			</div>
		{/each}
	{:else}
		<div class="vertical-tab-content relay-settings-page" bind:this={desktopContentEl}>
			{@render pageContent(currentView)}
		</div>
	{/if}

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
	.vertical-tab-content[hidden] {
		display: none;
	}

	.vertical-tab-content {
		flex: 1 1 auto;
		height: auto;
		min-height: 0;
		position: relative;
	}
</style>
