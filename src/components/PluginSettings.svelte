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
	import type { SettingsTarget } from "../ui/settingsTarget";
	import {
		closePage,
		openPage,
		resolvePage,
		resolvePages,
		type PageRules,
		type SettingsPage,
	} from "../ui/settingsStack";

	interface RelayEventDetail {
		relay: Relay;
	}

	type PageComponent =
		| typeof Relays
		| typeof MobileRemoteFolders
		| typeof ManageRelay
		| typeof ManageSharedFolder
		| typeof ManageRemoteFolder;

	// A page is a settings target plus the component shown when the target
	// alone does not decide it (the relay list and the remote folder browser).
	type View = SettingsPage<PageComponent>;

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
	const rootPage: View = { component: Relays };
	let currentView: View = rootPage;
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

	// A folder page shows the remote folder while it is live and the local
	// copy once the remote is gone; a relay page shows its relay. A page with
	// no records is the relay list, unless the remote folder browser was asked for.
	function componentFor(target: SettingsTarget, requested: PageComponent): PageComponent {
		return target.remoteFolder ? ManageRemoteFolder
			: target.sharedFolder ? ManageSharedFolder
			: target.currentRelay ? ManageRelay
			: requested === MobileRemoteFolders ? MobileRemoteFolders : Relays;
	}

	const rules: PageRules<PageComponent> = {
		records: { relays, remoteFolders, sharedFolders },
		componentFor,
	};

	// Phones keep stacked pages mounted, so an open ancestor is returned to
	// instead of being mounted again; desktop pushes every page. Opening the
	// page already on screen only scrolls it back to the top on desktop.
	function navigateTo(request: View) {
		const stack = openPage({ history, current: currentView }, request, rules, Platform.isMobile);
		history = stack.history;
		if (stack.current !== currentView) activate(stack.current);
		else if (!Platform.isMobile) activate(currentView);
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
				next.currentRelay = relays.get(next.remoteFolder.relayId);
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

	// Parents whose records are gone, or that would show the page already on
	// screen, are skipped so that one press always moves somewhere.
	function goBack(clear = false) {
		if (clear) {
			activate(history.find(isRoot) ?? rootPage);
			history = [];
			return;
		}
		const stack = closePage({ history, current: currentView }, rules, rootPage);
		history = stack.history;
		activate(stack.current);
	}

	function handleClose() {
		history = [];
		close();
	}

	// On phones, retained hidden pages can finish asynchronous work; only the
	// visible page may initiate navigation. On desktop the pane shows one page.
	function fromPage<T>(page: View, handle: (event: T) => unknown) {
		return (event: T) => {
			if (page === currentView) handle(event);
		};
	}

	// Records can disappear before their deferred observers run. Re-resolve
	// every page whenever the records or the stack change: the result is a
	// fixed point, so this settles after one pass.
	$: {
		void [$relays, $remoteFolders, $sharedFolders, history, currentView];
		const parents = resolvePages(history, rules);
		if (parents.length !== history.length || parents.some((page, i) => page !== history[i])) {
			history = parents;
		}
		const current = resolvePage(currentView, rules);
		if (!current) {
			goBack();
		} else if (current !== currentView) {
			currentView = current;
		}
	}
</script>

{#snippet pageContent(page: View)}
	{#if page.remoteFolder}
		<!-- The page binds its stores to the folder it mounted with, so a
		     page for a different remote folder is a fresh mount. -->
		{#key page.remoteFolder.id}
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
		{/key}
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
	<!-- On phones the settings header overlays the top of the tab and its own
	     back arrow drives this view's history, so Relay's chevron bar would
	     only sit hidden beneath it. -->
	{#if !atRoot && !Platform.isPhone}
		<ModalSettingsNav on:goBack={handleGoBack}></ModalSettingsNav>
	{:else if atRoot && !Platform.isMobile}
		<Announcement {plugin} />
	{/if}
	{#if Platform.isMobile}
		<!-- Pages stay mounted while they are on the stack, so Back returns to
		     the same scroll position and form state. -->
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
