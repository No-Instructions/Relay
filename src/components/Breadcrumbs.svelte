<script lang="ts">
	import { ChevronRight, FolderOpen, Folder as FolderIcon, FolderLock, Satellite as SatelliteIcon } from "lucide-svelte";
	import { createEventDispatcher } from "svelte";

	interface TextBreadcrumb {
		type: "text";
		text: string;
		onClick?: () => void;
	}

	interface SatelliteBreadcrumb {
		type: "satellite";
		relay: any;
		onClick?: () => void;
	}

	interface FolderBreadcrumb {
		type: "folder";
		folder?: any;
		remoteFolder?: any;
		isPrivate?: boolean;
		onClick?: () => void;
	}

	interface RemoteFolderBreadcrumb {
		type: "remoteFolder";
		remoteFolder: any;
		onClick?: () => void;
	}

	type BreadcrumbItem = TextBreadcrumb | SatelliteBreadcrumb | FolderBreadcrumb | RemoteFolderBreadcrumb;

	export let items: BreadcrumbItem[];

	const dispatch = createEventDispatcher();

	function handleClick(item: BreadcrumbItem) {
		if (item.onClick) {
			item.onClick();
		}
	}

	function getIcon(item: BreadcrumbItem) {
		switch (item.type) {
			case "satellite":
				return SatelliteIcon;
			case "folder":
				return FolderOpen;
			case "remoteFolder":
				return item.remoteFolder?.private ? FolderLock : FolderIcon;
			default:
				return null;
		}
	}

</script>

<h4 style="display: flex; align-items: center; gap: 8px;">
	{#each items as item, index}
		{#if index > 0}
			<ChevronRight size={16} />
		{/if}
		
		{#if item.onClick}
			<span style="display: flex; align-items: center; gap: 0.3em;">
				{#if getIcon(item)}
					<svelte:component 
						this={getIcon(item)} 
						class="svg-icon" 
						style="margin-right: .2em; flex-shrink: 0" 
					/>
				{/if}
				<span
					on:click={() => handleClick(item)}
					on:keypress={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							handleClick(item);
						}
					}}
					tabindex="0"
					role="button"
					style="cursor: pointer;"
				>
					{#if item.type === "text"}
						{item.text}
					{:else if item.type === "satellite"}
						{#if item.relay?.name}
							{item.relay.name}
						{:else}
							<span class="faint">(Untitled Relay Server)</span>
						{/if}
					{:else if item.type === "folder"}
						{item.folder?.name || item.remoteFolder?.name || "Unnamed Folder"}
					{:else if item.type === "remoteFolder"}
						{item.remoteFolder?.name || "Unnamed Folder"}
					{:else}
						Unknown
					{/if}
				</span>
			</span>
		{:else if index === items.length - 1}
			<!-- Last item with icon and slot content -->
			<span style="display: flex; align-items: center; gap: 0.3em; flex: 1; min-width: 0;">
				{#if getIcon(item)}
					<svelte:component 
						this={getIcon(item)} 
						class="svg-icon" 
						style="margin-right: .2em; flex-shrink: 0" 
					/>
				{/if}
				<span style="flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">
					{#if $$slots.default}
						<slot />
					{:else if item.type === "text"}
						{item.text}
					{:else if item.type === "satellite"}
						{#if item.relay?.name}
							{item.relay.name}
						{:else}
							<span class="faint">(Untitled Relay Server)</span>
						{/if}
					{:else if item.type === "folder"}
						{item.folder?.name || item.remoteFolder?.name || "Unnamed Folder"}
					{:else if item.type === "remoteFolder"}
						{item.remoteFolder?.name || "Unnamed Folder"}
					{:else}
						Unknown
					{/if}
				</span>
			</span>
		{:else}
			<!-- Non-clickable intermediate items -->
			{#if item.type === "text"}
				{item.text}
			{:else if item.type === "satellite"}
				{#if item.relay?.name}
					{item.relay.name}
				{:else}
					<span class="faint">(Untitled Relay Server)</span>
				{/if}
			{:else if item.type === "folder"}
				{item.folder?.name || item.remoteFolder?.name || "Unnamed Folder"}
			{:else if item.type === "remoteFolder"}
				{item.remoteFolder?.name || "Unnamed Folder"}
			{:else}
				Unknown
			{/if}
		{/if}
	{/each}
</h4>

<style>
	.faint {
		color: var(--text-faint);
	}
</style>