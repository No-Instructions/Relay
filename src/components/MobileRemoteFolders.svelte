<script lang="ts">
	import type Live from "../main";
	import { derived } from "svelte/store";
	import {
		accessibleRemoteFolders,
		groupRemoteFoldersByRelay,
	} from "../ui/groupRemoteFoldersByRelay";
	import SettingGroup from "./SettingGroup.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import MobileRemoteFolderRow from "./MobileRemoteFolderRow.svelte";
	import Satellite from "./Satellite.svelte";

	export let plugin: Live;
	const remoteFolders = plugin.relayManager.remoteFolders;
	const relays = plugin.relayManager.relays;
	const sharedFolders = plugin.sharedFolders;
	$: localFolders = new Map(
		$sharedFolders.items().map((folder) => [folder.guid, folder]),
	);
	// Folder-role changes notify remoteFolders without changing the relay map.
	const groups = derived([relays, remoteFolders], ([$relays, $remoteFolders]) =>
		groupRemoteFoldersByRelay(
			accessibleRemoteFolders($relays.values(), $remoteFolders.values()),
		),
	);
</script>

<SettingItemHeading name="Remote folders" />
{#each $groups as group (group.relay.guid)}
	<div class="remote-folder-group">
		<SettingGroup list>
			{#each group.folders as remoteFolder (remoteFolder.guid)}
				<MobileRemoteFolderRow
					{plugin}
					{remoteFolder}
					localFolder={localFolders.get(remoteFolder.guid)}
					on:manageRemoteFolder
				/>
			{/each}
		</SettingGroup>
		<div class="relay-footer">
			<Satellite relay={group.relay} on:manageRelay
				><span class="relay-name">{group.relay.name}</span></Satellite
			>
		</div>
	</div>
{:else}
	<p class="empty-message">
		Join a Relay Server, or add a shared folder on another device.
	</p>
{/each}

<style>
	.remote-folder-group {
		margin-bottom: 12px;
	}
	.remote-folder-group :global(.setting-group) {
		margin-bottom: 0;
	}
	.relay-footer {
		display: flex;
		align-items: flex-start;
		min-height: 44px;
		padding: 4px 20px 0;
		box-sizing: border-box;
		color: var(--text-muted);
		font-size: var(--font-ui-smaller);
	}
	.relay-footer :global(svg) {
		width: 16px;
		height: 16px;
		flex: 0 0 16px;
	}
	.relay-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty-message {
		color: var(--text-muted);
	}
</style>
