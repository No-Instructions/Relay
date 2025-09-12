<script lang="ts">
	import {
		ChevronRight,
		Layers,
		Home as HomeIcon,
		Folder as FolderIcon,
		FolderLock,
		Satellite as SatelliteIcon,
	} from "lucide-svelte";
	import type { Relay, RemoteSharedFolder } from "src/Relay";
	import type { SharedFolder } from "src/SharedFolder";
	import { createEventDispatcher } from "svelte";

	interface HomeBreadcrumb {
		type: "home";
		onClick?: () => void;
	}

	interface TextBreadcrumb {
		type: "text";
		text: string;
		onClick?: () => void;
	}

	interface RelayBreadcrumb {
		type: "relay";
		relay: Relay;
		onClick?: () => void;
	}

	interface FolderBreadcrumb {
		type: "folder";
		folder: SharedFolder;
		onClick?: () => void;
	}

	interface RemoteFolderBreadcrumb {
		type: "remoteFolder";
		remoteFolder: RemoteSharedFolder;
		onClick?: () => void;
	}

	type BreadcrumbItem =
		| HomeBreadcrumb
		| TextBreadcrumb
		| RelayBreadcrumb
		| FolderBreadcrumb
		| RemoteFolderBreadcrumb;

	export let items: BreadcrumbItem[];
	export let element: string = "h4";

	const dispatch = createEventDispatcher();

	function handleClick(item: BreadcrumbItem) {
		if (item.onClick) {
			item.onClick();
		}
	}

	function getIcon(item: BreadcrumbItem) {
		switch (item.type) {
			case "home":
				return HomeIcon;
			case "relay":
				return SatelliteIcon;
			case "folder":
				return Layers;
			case "remoteFolder":
				return item.remoteFolder?.private ? FolderLock : FolderIcon;
			default:
				return null;
		}
	}
</script>

<svelte:element
	this={element}
	style="display: flex; align-items: center; gap: 8px;"
>
	{#each items as item, index}
		{#if index > 0}
			<ChevronRight size={16} />
		{/if}

		<span style="display: flex; align-items: center; gap: 0.3em;">
			<span
				on:click={() => handleClick(item)}
				on:keypress={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						handleClick(item);
					}
				}}
				tabindex="0"
				role="button"
				style="display: flex; align-items: center; gap: 0.3em;"
			>
				{#if getIcon(item)}
					<svelte:component
						this={getIcon(item)}
						class="svg-icon"
						style="margin-right: .2em; flex-shrink: 0"
					/>
				{/if}
				{#if item.type === "text"}
					{item.text}
				{:else if item.type === "relay"}
					{#if item.relay.name}
						{item.relay.name}
					{:else}
						<span class="faint">(Untitled Relay Server)</span>
					{/if}
				{:else if item.type === "folder"}
					{item.folder.name}
				{:else if item.type === "remoteFolder"}
					{#if item.remoteFolder.name}
						{item.remoteFolder.name}
					{:else}
						<span class="faint">(Untitled folder)</span>
					{/if}
				{/if}
			</span>
		</span>
	{/each}
</svelte:element>

<style>
	.faint {
		color: var(--text-faint);
	}
</style>
