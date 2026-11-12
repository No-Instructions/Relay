<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import { debounce } from "obsidian";
	import { ArrowUpDown } from "lucide-svelte";
	import type { Relay } from "src/Relay";
	import type { SharedFolder } from "src/SharedFolder";
	import { groupSharedFoldersByRelay } from "src/ui/groupSharedFoldersByRelay";
	import Folder from "./Folder.svelte";
	import RemoteFolder from "./RemoteFolder.svelte";
	import Satellite from "./Satellite.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import SettingItem from "./SettingItem.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import SettingsControl from "./SettingsControl.svelte";

	export let folders: SharedFolder[];
	export let relays: Relay[];

	const dispatch = createEventDispatcher();
	$: groups = groupSharedFoldersByRelay(folders, relays);
</script>

{#if folders.length === 0}
	<SettingGroup list>
		<SettingItem
			description="No shared folders on this device. Share folders from a Relay Server's settings page to begin collaboration."
		/>
	</SettingGroup>
{/if}
{#each groups as group (group.relayId)}
	<div class="mobile-folder-group">
		<SettingGroup list>
			{#each group.folders as folder (folder.guid)}
				<SlimSettingItem>
					<span class="folder-name" slot="name">
						{#if folder.remote}
							<RemoteFolder remoteFolder={folder.remote} on:manageRemoteFolder>
								<span class="folder-label">{folder.name}</span>
							</RemoteFolder>
						{:else}
							<Folder {folder} on:manageSharedFolder>
								<span class="folder-label">{folder.name}</span>
							</Folder>
						{/if}
					</span>
					<SettingsControl
						action="manage-folder"
						on:settings={debounce(() => {
							if (folder.remote) {
								dispatch("manageRemoteFolder", { remoteFolder: folder.remote });
							} else {
								dispatch("manageSharedFolder", { folder });
							}
						})}
					/>
				</SlimSettingItem>
			{/each}
		</SettingGroup>
		{#if group.relay}
			<div class="relay-footer">
				<span class="sync-icon" aria-hidden="true">
					<ArrowUpDown size={14} class="svg-icon" />
				</span>
				<Satellite relay={group.relay} on:manageRelay>
					<span class="relay-name">{group.relay.name || "(Untitled Relay Server)"}</span>
				</Satellite>
			</div>
		{/if}
	</div>
{/each}

<div class="add-remote-folder">
	<button
		class="mod-cta system3-button"
		aria-label="Add remote folder to vault"
		on:click={() => dispatch("addRemoteFolder")}
	>
		Add remote folder
	</button>
</div>

<style>
	.mobile-folder-group {
		margin-bottom: 12px;
	}
	.mobile-folder-group :global(.setting-group) {
		margin-bottom: 0;
	}
	.mobile-folder-group :global(.setting-item-info) {
		margin-inline-end: 0;
	}
	.mobile-folder-group :global([data-action="manage-folder"]) {
		width: 44px;
		height: 44px;
	}
	.folder-name {
		display: flex;
		width: 100%;
		min-width: 0;
	}
	.folder-name :global([role="button"]) {
		min-width: 0;
	}
	.folder-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.relay-footer {
		position: relative;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller);
	}
	.relay-footer :global(> span[role="button"]) {
		box-sizing: border-box;
		min-height: 44px;
		padding: 4px 20px 0 40px;
		align-items: flex-start !important;
		gap: 4px;
	}
	.relay-footer :global(.lucide-satellite) {
		width: 16px;
		height: 16px;
		margin: 0 !important;
	}
	.sync-icon {
		position: absolute;
		top: 4px;
		left: 20px;
		display: flex;
		pointer-events: none;
	}
	.sync-icon :global(svg) {
		width: 14px;
		height: 14px;
	}
	.relay-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.add-remote-folder {
		display: flex;
		justify-content: flex-end;
		padding: 0 20px;
		margin-bottom: 24px;
	}
	.add-remote-folder button {
		min-height: 44px;
		max-width: 11em;
	}
</style>
