<script lang="ts">
	import LoggedIn from "./LoggedIn.svelte";
	import Relays from "./Relays.svelte";
	import ManageRelay from "./ManageRelay.svelte";
	import { type Relay } from "../Relay";
	import ModalSettingsNav from "./ModalSettingsNav.svelte";
	import type Live from "src/main";
	import type { SharedFolder } from "src/SharedFolder";
	import ManageSharedFolder from "./ManageSharedFolder.svelte";
	import ManageRemoteFolder from "./ManageRemoteFolder.svelte";
	import { minimark } from "src/minimark";
	import type { RemoteSharedFolder } from "src/Relay";
	import ToastManager from "./ToastManager.svelte";
	import { handleServerError } from "../utils/toastStore";
	import { flags } from "../flagManager";

	interface RelayEventDetail {
		relay: Relay;
	}

	interface View {
		currentRelay?: Relay;
		sharedFolder?: SharedFolder;
		remoteFolder?: RemoteSharedFolder;
		component:
			| typeof Relays
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
	interface ManageSharedFolderEvent
		extends CustomEvent<SharedFolderEventDetail> {}
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
		| typeof ManageRelay
		| typeof ManageSharedFolder
		| typeof ManageRemoteFolder = Relays;

	let currentRelay: Relay | undefined;
	let remoteFolder: RemoteSharedFolder | undefined;
	const history: View[] = [{ component: Relays }];

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
		history.push({
			currentRelay,
			sharedFolder,
			remoteFolder,
			component: currentComponent,
		});
		currentRelay = event.detail.relay;
		sharedFolder = undefined;
		remoteFolder = undefined;
		currentComponent = ManageRelay;
	}
	function handleManageSharedFolderEvent(event: ManageSharedFolderEvent) {
		history.push({
			currentRelay,
			sharedFolder,
			remoteFolder,
			component: currentComponent,
		});
		sharedFolder = event.detail.folder;
		remoteFolder = event.detail.remoteFolder;
		currentRelay = event.detail.relay;
		currentComponent = ManageSharedFolder;
	}

	function handleManageRemoteFolderEvent(event: ManageSharedFolderEvent) {
		history.push({
			currentRelay,
			sharedFolder,
			remoteFolder,
			component: currentComponent,
		});
		sharedFolder = undefined; // No local folder
		remoteFolder = event.detail.remoteFolder;
		currentRelay = event.detail.relay;
		currentComponent = ManageRemoteFolder;
	}

	async function handleCreateRelayEvent(event: CreateRelayEvent) {
		try {
			history.push({
				currentRelay,
				sharedFolder,
				remoteFolder,
				component: currentComponent,
			});
			currentRelay = await plugin.relayManager.createRelay("");
			currentComponent = ManageRelay;
		} catch (error: any) {
			handleServerError(error, "Failed to create relay");
		}
	}

	function handleGoBack(event: GoBackEvent) {
		if (event.detail.clear) {
			history.length = 0;
			currentRelay = undefined;
			sharedFolder = undefined;
			remoteFolder = undefined;
			currentComponent = Relays;
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
				} else if (view.sharedFolder && sharedFolders.has(view.sharedFolder)) {
					currentRelay = view.currentRelay;
					sharedFolder = view.sharedFolder;
					remoteFolder = view.remoteFolder;
					currentComponent = view.component;
					break;
				} else if (view.remoteFolder) {
					currentRelay = view.currentRelay;
					sharedFolder = view.sharedFolder;
					remoteFolder = view.remoteFolder;
					currentComponent = view.component;
					break;
				} else if (
					view.currentRelay &&
					relayManager.relays.get(view.currentRelay.id)
				) {
					currentRelay = view.currentRelay;
					sharedFolder = view.sharedFolder;
					remoteFolder = view.remoteFolder;
					currentComponent = view.component;
					break;
				}
				view = history.pop();
			}
		} else {
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
		currentRelay = event.detail.relay;
		currentComponent = ManageRelay;
	}

	$: {
		if (currentRelay && !$relays.has(currentRelay.id)) {
			currentRelay = undefined;
			currentComponent = Relays;
		}
	}

	$: {
		if (sharedFolder && !sharedFolders.has(sharedFolder)) {
			sharedFolder = undefined;
			remoteFolder = undefined;
			currentComponent = Relays;
		}
	}

	$: if (currentComponent || currentRelay || sharedFolder || remoteFolder) {
		setTimeout(() => {
			const content = document.querySelector(".vertical-tab-content");
			if (content) {
				content.scrollTop = 0;
			}
		}, 0);
	}

	function install() {
		if (plugin.networkStatus.status?.versions) {
			if (plugin.releaseSettings.get().channel === "stable") {
				plugin.installVersion(plugin.networkStatus.status.versions.stable);
			} else if (plugin.releaseSettings.get().channel === "beta") {
				plugin.installVersion(plugin.networkStatus.status.versions.beta);
			}
		}
	}
</script>

{#if currentRelay || sharedFolder || remoteFolder}
	<ModalSettingsNav on:goBack={handleGoBack}></ModalSettingsNav>
{:else if plugin.networkStatus.status}
	<div
		class="modal-setting-nav-bar system3-announcement-banner"
		on:click={() => {
			if (plugin.networkStatus.status?.versions) {
				install();
			} else if (plugin.networkStatus.status?.link) {
				window.open(plugin.networkStatus.status.link);
			}
		}}
		role="button"
		tabindex="0"
		on:keypress={() => {
			if (plugin.networkStatus.status?.versions) {
				install();
			} else if (plugin.networkStatus.status?.link) {
				window.open(plugin.networkStatus.status.link);
			}
		}}
		style="background-color: {plugin.networkStatus.status.backgroundColor
			? plugin.networkStatus.status.backgroundColor
			: 'var(--color-accent)'} !important"
	>
		<span
			class="system3-announcement"
			style="color: {plugin.networkStatus.status.color
				? plugin.networkStatus.status.color
				: 'var(--text-on-accent)'} !important"
		>
			{#if plugin.networkStatus.status}
				{@html minimark(plugin.networkStatus.status.status)}
			{/if}
		</span>
	</div>
{/if}
<div class="vertical-tab-content">
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
			></Relays>
		</LoggedIn>
	{/if}
</div>

{#if flags().enableToasts}
	<ToastManager />
{/if}

{#if plugin.manifest.version !== plugin.version}
	<span class="relay-version">
		{plugin.version}
	</span>
{/if}

<style>
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
		max-height: var(--modal-max-height);
		position: relative;
	}
	.system3-announcement-banner {
		padding-left: 48px !important;
	}
	.system3-announcement {
		color: var(--text-on-accent);
	}
</style>
