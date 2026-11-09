<script lang="ts">
	import { onDestroy, createEventDispatcher } from "svelte";
	import { Download, Folder, FolderLock, Settings } from "lucide-svelte";
	import { normalizePath } from "obsidian";
	import { remoteFolderRelay } from "../ui/groupRemoteFoldersByRelay";
	import { remoteFolderDownloadPath } from "../ui/remoteFolderDownloadPath";
	import type Live from "../main";
	import type { SharedFolder } from "../SharedFolder";
	import type { RemoteSharedFolder } from "../Relay";
	import {
		observeInitialFolderDownload,
		type InitialDownloadProgress,
	} from "../ui/initialFolderDownload";
	import { ownerWin } from "./ownerWindow";

	export let plugin: Live;
	export let remoteFolder: RemoteSharedFolder;
	export let localFolder: SharedFolder | undefined = undefined;
	const dispatch = createEventDispatcher();
	let row: HTMLDivElement;
	let pending = false;
	let progress: InitialDownloadProgress | undefined;
	let visible = false;
	let fading = false;
	let error = "";
	let disposed = false;
	let stopProgress: (() => void) | undefined;
	let holdTimer: number | undefined;
	let fadeTimer: number | undefined;
	let finishing = false;

	function manage() {
		const relay = remoteFolderRelay(remoteFolder);
		if (relay) dispatch("manageRemoteFolder", { remoteFolder, relay });
	}

	async function download() {
		if (pending || localFolder) return;
		pending = true;
		visible = true;
		fading = false;
		error = "";
		progress = { percent: 0, completed: 0, total: 0, complete: false };
		try {
			const relay = remoteFolderRelay(remoteFolder);
			if (!relay) throw new Error("This Relay Server is no longer available.");
			const path = remoteFolderDownloadPath(
				remoteFolder.name,
				normalizePath,
				(path) => !!plugin.app.vault.getAbstractFileByPath(path),
			);
			await plugin.app.vault.createFolder(path);
			const folder = plugin.sharedFolders.clone(
				path,
				remoteFolder.guid,
				relay.guid,
			);
			folder.remote = remoteFolder;
			if (disposed) return;
			localFolder = folder;
			const win = ownerWin(row);
			stopProgress = observeInitialFolderDownload(
				folder,
				plugin.app.vault,
				{
					setTimeout: (callback, delay) => win.setTimeout(callback, delay),
					clearTimeout: (timer) => win.clearTimeout(timer),
				},
				(snapshot) => {
					progress = snapshot;
					if (!snapshot.complete && finishing) {
						if (holdTimer !== undefined) win.clearTimeout(holdTimer);
						if (fadeTimer !== undefined) win.clearTimeout(fadeTimer);
						finishing = false;
						fading = false;
					}
					if (snapshot.error) {
						error =
							"Download could not finish. Open folder settings to check its connection.";
						visible = false;
						stopProgress?.();
						stopProgress = undefined;
					} else if (snapshot.complete && !finishing) {
						finishing = true;
						holdTimer = win.setTimeout(() => {
							fading = true;
							fadeTimer = win.setTimeout(() => {
								visible = false;
								stopProgress?.();
								stopProgress = undefined;
							}, 600);
						}, 700);
					}
				},
			);
		} catch (cause) {
			if (!disposed) {
				error = cause instanceof Error ? cause.message : String(cause);
				visible = false;
			}
		} finally {
			pending = false;
		}
	}

	onDestroy(() => {
		disposed = true;
		stopProgress?.();
		const win = ownerWin(row);
		if (holdTimer !== undefined) win.clearTimeout(holdTimer);
		if (fadeTimer !== undefined) win.clearTimeout(fadeTimer);
	});
</script>

<div
	class="setting-item mod-list-item remote-folder-row"
	bind:this={row}
	data-remote-folder-guid={remoteFolder.guid}
	aria-busy={visible && !progress?.complete}
>
	<span
		class="download-fill"
		class:visible
		class:fading
		style:--relay-download-progress={`${progress?.percent ?? 0}%`}
		role={visible ? "progressbar" : undefined}
		aria-hidden={!visible}
		aria-label={`Downloading ${remoteFolder.name}`}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={progress?.total ? progress.percent : undefined}
	></span>
	<div class="setting-item-info">
		<button
			class="folder-name"
			on:click={manage}
			aria-label={`Settings for ${remoteFolder.name}`}
		>
			{#if remoteFolder.private}<FolderLock
					size={20}
					class="svg-icon"
				/>{:else}<Folder size={20} class="svg-icon" />{/if}
			<span class="folder-label">{remoteFolder.name}</span>
		</button>
		{#if error}<div
				class="setting-item-description download-error"
				role="status"
			>
				{error}
			</div>{/if}
	</div>
	<div class="setting-item-control">
		{#if !localFolder}
			<button
				class="clickable-icon folder-control"
				disabled={pending}
				aria-label={`Download ${remoteFolder.name}`}
				on:click={download}><Download size={20} class="svg-icon" /></button
			>
		{/if}
		<button
			class="clickable-icon folder-control"
			aria-label={`Settings for ${remoteFolder.name}`}
			on:click={manage}><Settings size={20} class="svg-icon" /></button
		>
	</div>
</div>

<style>
	.remote-folder-row {
		position: relative;
		isolation: isolate;
		flex-direction: row;
		align-items: center;
		gap: 16px;
	}
	.setting-item-info {
		min-width: 0;
		margin-inline-end: 0;
		position: relative;
		z-index: 1;
	}
	.setting-item-control {
		flex: 0 0 auto;
		width: auto;
		margin-top: 0;
		justify-content: flex-end;
		gap: 8px;
		position: relative;
		z-index: 1;
	}
	.folder-name {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 4px;
		min-width: 0;
		width: 100%;
		min-height: 44px;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		color: var(--text-normal);
		text-align: start;
		font: inherit;
	}
	.folder-name :global(svg) {
		flex: 0 0 20px;
	}
	.folder-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.folder-control {
		width: 44px;
		height: 44px;
		padding: 0;
	}
	.folder-control :global(svg) {
		flex-shrink: 0;
	}
	.download-error {
		color: var(--text-error);
	}
	.download-fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: var(--relay-download-progress, 0%);
		border-radius: inherit;
		background: var(--text-normal);
		opacity: 0;
		pointer-events: none;
		z-index: 0;
		transition:
			width 180ms linear,
			opacity 550ms ease;
	}
	.download-fill.visible {
		opacity: 0.055;
	}
	.download-fill.fading {
		opacity: 0;
	}
	@media (prefers-reduced-motion: reduce) {
		.download-fill {
			transition: none;
		}
	}
</style>
