<script lang="ts">
	import { Pause, Play } from "lucide-svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import FolderSyncStatus from "./FolderSyncStatus.svelte";
	import type { SharedFolder, SharedFolders } from "../SharedFolder";
	import type { BackgroundSync } from "../BackgroundSync";
	import Folder from "./Folder.svelte";

	// Props
	export let backgroundSync: BackgroundSync;
	export let sharedFolders: SharedFolders;
	export let focusedFolderGuid: string | undefined;

	// State variables
	let expandedFolders = {};
	let activeFilesCount = 0;
	let stuckFilesCount = 0;
	let queuedFilesCount = 0;
	let completedFilesCount = 0;

	$: folders = sharedFolders
		.items()
		.sort((a, b) => a.name.localeCompare(b.name));

	$: {
		folders.forEach((folder) => {
			if (!(folder.guid in expandedFolders)) {
				expandedFolders[folder.guid] = true;
			}
		});
		expandedFolders = expandedFolders;
	}

	$: focusedFolder = focusedFolderGuid
		? sharedFolders.items().find((f) => f.guid === focusedFolderGuid)
		: undefined;

	const { activeSync, activeDownloads } = backgroundSync;

	$: folderStatuses = new Map(
		folders.map((folder) => [
			folder.guid,
			{
				progress: backgroundSync.getGroupProgress(folder)?.percent || 0,
				running: [...$activeSync.items(), ...$activeDownloads.items()].filter(
					(i) => i.sharedFolder.guid === folder.guid,
				).length,
				failed:
					backgroundSync.syncGroups.get(folder)?.status === "failed" ? 1 : 0,
				pending: [
					...backgroundSync.pendingSyncs,
					...backgroundSync.pendingDownloads,
				].filter((i) => i.sharedFolder.guid === folder.guid).length,
				completed: (() => {
					const group = backgroundSync.syncGroups.get(folder);
					return (
						(group?.completedSyncs || 0) + (group?.completedDownloads || 0)
					);
				})(),
				sharedFolder: folder,
			},
		]),
	);

	$: focusedFolderStatus = focusedFolder
		? folderStatuses.get(focusedFolder.guid)
		: undefined;

	// Queue status
	$: queueStatus = backgroundSync.getQueueStatus();
	$: isPaused = queueStatus.isPaused;
	$: isProcessing =
		queueStatus.syncsActive > 0 || queueStatus.downloadsActive > 0;

	// Calculate overall counts
	$: {
		let active = 0;
		let stuck = 0;
		let queued = 0;
		let completed = 0;

		for (const status of folderStatuses.values()) {
			active += status.running;
			stuck += status.failed;
			queued += status.pending;
			completed += status.completed;
		}

		activeFilesCount = active;
		stuckFilesCount = stuck;
		queuedFilesCount = queued;
		completedFilesCount = completed;
	}

	$: isSyncing = activeFilesCount > 0;
	$: hasPendingSync = queuedFilesCount > 0;

	function toggleFolder(folderId: string) {
		expandedFolders[folderId] = !expandedFolders[folderId];
		expandedFolders = expandedFolders;
	}

	function togglePause() {
		if (isPaused) {
			backgroundSync.resume();
		} else {
			backgroundSync.pause();
		}
	}
</script>

<div class="setting-item-container">
	{#if !focusedFolder}
		<SettingItemHeading name="Sync Status" />
	{/if}

	{#if !focusedFolder}
		<SettingItem
			name={isSyncing
				? "Sync in Progress"
				: hasPendingSync
					? "Queued Files"
					: "Sync Complete"}
			description={`${activeFilesCount} active • ${stuckFilesCount} stuck • ${queuedFilesCount} queued • ${completedFilesCount} complete`}
		>
			{#if isSyncing || hasPendingSync}
				<button class="mod-cta" on:click={togglePause}>
					{#if isPaused}
						<Play
							size={16}
							class="svg-icon lucide-play"
							style="margin-right: 8px;"
						/>
						Resume
					{:else}
						<Pause
							size={16}
							class="svg-icon lucide-pause"
							style="margin-right: 8px;"
						/>
						Pause
					{/if}
				</button>
			{/if}
		</SettingItem>
	{/if}

	{#if focusedFolder && focusedFolderStatus}
		<SettingItemHeading>
			<svelte:fragment slot="name">
				<Folder folder={focusedFolder}>
					<div class="folder-header">
						{focusedFolder.name}
						<span class="sync-stats">
							{#if focusedFolderStatus.running > 0}
								<span class="tag mod-success"
									>{focusedFolderStatus.running} active</span
								>
							{/if}
							{#if focusedFolderStatus.failed > 0}
								<span class="tag mod-warning"
									>{focusedFolderStatus.failed} stuck</span
								>
							{/if}
							{#if focusedFolderStatus.pending > 0}
								<span class="tag">{focusedFolderStatus.pending} queued</span>
							{/if}
						</span>
					</div>
				</Folder>
			</svelte:fragment>
			{#if focusedFolderStatus.running > 0 || focusedFolderStatus.failed > 0}
				<div class="progress-container">
					<div class="progress-bar">
						<div
							class="progress-value"
							style="width: {focusedFolderStatus.progress}%"
						/>
					</div>
					<span class="progress-text">{focusedFolderStatus.progress}%</span>
				</div>
			{/if}
		</SettingItemHeading>
		<FolderSyncStatus folder={focusedFolder} {backgroundSync} />
	{:else}
		{#each folders as folder (folder.guid)}
			{@const status = folderStatuses.get(folder.guid)}
			<SettingItemHeading>
				<svelte:fragment slot="name">
					<Folder {folder}>
						<div
							class="folder-header"
							on:click={() => toggleFolder(folder.guid)}
							on:keydown={(e) => e.key === "Enter" && toggleFolder(folder.guid)}
							role="button"
							tabindex="0"
							aria-expanded={!!expandedFolders[folder.guid]}
						>
							<span
								class="arrow {expandedFolders[folder.guid]
									? 'is-expanded'
									: ''}">▶</span
							>
							{folder.name}
							<span class="sync-stats">
								{#if status?.running > 0}
									<span class="tag mod-success">{status.running} active</span>
								{/if}
								{#if status?.failed > 0}
									<span class="tag mod-warning">{status.failed} stuck</span>
								{/if}
								{#if status?.pending > 0}
									<span class="tag">{status.pending} queued</span>
								{/if}
							</span>
						</div>
					</Folder>
				</svelte:fragment>
				{#if status && (status.running > 0 || status.failed > 0)}
					<div class="progress-container">
						<div class="progress-bar">
							<div class="progress-value" style="width: {status.progress}%" />
						</div>
						<span class="progress-text">{status.progress}%</span>
					</div>
				{/if}
			</SettingItemHeading>

			{#if expandedFolders[folder.guid]}
				<FolderSyncStatus {folder} {backgroundSync} />
			{/if}
		{/each}
	{/if}
</div>

<style>
	.folder-header {
		display: flex;
		align-items: center;
		cursor: pointer;
		background: none;
		border: none;
		padding: 0;
		width: 100%;
		text-align: left;
		color: inherit;
		font: inherit;
	}

	.arrow {
		margin-right: 8px;
		font-size: 0.8em;
		transition: transform 0.15s ease;
	}

	.arrow.is-expanded {
		transform: rotate(90deg);
	}

	.sync-stats {
		margin-left: 8px;
		display: flex;
		gap: 4px;
	}

	.tag {
		font-size: 0.7em;
		padding: 2px 6px;
		border-radius: 4px;
		background-color: var(--background-modifier-border);
		color: var(--text-muted);
	}

	.tag.mod-success {
		background-color: var(--interactive-success);
		color: var(--text-on-accent);
	}

	.tag.mod-warning {
		background-color: var(--text-warning);
		color: var(--text-on-accent);
	}

	.progress-container {
		display: flex;
		align-items: center;
		margin-top: 4px;
		width: 100%;
	}

	.progress-bar {
		flex: 1;
		height: 6px;
		background-color: var(--background-modifier-border);
		border-radius: 3px;
		overflow: hidden;
		margin-right: 8px;
	}

	.progress-value {
		height: 100%;
		background-color: var(--interactive-accent);
		border-radius: 3px;
	}

	.progress-text {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
</style>
