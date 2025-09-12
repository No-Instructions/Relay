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

<svelte:element this={element} class="breadcrumb-container">
	{#each items as item, index}
		{#if index > 0}
			<ChevronRight size={16} class="breadcrumb-separator" />
		{/if}

		<span class="breadcrumb-item-wrapper">
			<span
				on:click={() => handleClick(item)}
				on:keypress={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						handleClick(item);
					}
				}}
				tabindex="0"
				role="button"
				class="breadcrumb-item {index === 0 ? 'first-item' : ''} {index ===
				items.length - 1
					? 'last-item'
					: ''} {index > 0 && index < items.length - 1 ? 'middle-item' : ''}"
			>
				{#if getIcon(item)}
					<svelte:component
						this={getIcon(item)}
						class="svg-icon breadcrumb-icon"
					/>
				{/if}
				<span class="breadcrumb-text">
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
		</span>
	{/each}
</svelte:element>

<style>
	.faint {
		color: var(--text-faint);
	}

	.breadcrumb-container {
		display: flex;
		align-items: center;
		gap: 8px;
		overflow: hidden;
	}

	.breadcrumb-item-wrapper {
		display: flex;
		align-items: center;
		gap: 0.3em;
		min-width: 0;
	}

	.breadcrumb-item {
		display: flex;
		align-items: center;
		gap: 0.3em;
		cursor: pointer;
		min-width: 0;
	}

	.breadcrumb-text {
		display: inline-block;
	}

	@media (max-width: 768px) {
		.breadcrumb-item-wrapper:last-child {
			flex: 1;
			min-width: 0;
			overflow: hidden;
		}

		.middle-item .breadcrumb-text {
			display: none;
		}

		.last-item {
			overflow: hidden;
		}

		.last-item .breadcrumb-text {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	}
</style>
