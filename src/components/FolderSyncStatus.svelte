<script lang="ts">
	import {
		RefreshCw,
		AlertTriangle,
		CheckCircle,
		Clock,
		Upload,
		Download,
		Info,
		ArrowUpDown,
	} from "lucide-svelte";
	import type { SharedFolder } from "../SharedFolder";
	import type { Document } from "../Document";
	import type { BackgroundSync } from "../BackgroundSync";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import { derived, writable } from "svelte/store";

	export let folder: SharedFolder;
	export let backgroundSync: BackgroundSync;

	$: activeSyncs = new Set(backgroundSync.activeSync.items());
	$: activeDownloads = new Set(backgroundSync.activeDownloads.items());
	$: syncLog = backgroundSync.getSyncLog();

	interface CollapsibleGroupConfig {
		initialCount: number;
		incrementCount: number;
	}

	const groupConfigs: Record<string, CollapsibleGroupConfig> = {
		"Active Files": {
			initialCount: Infinity,
			incrementCount: 100,
		},
		"Stuck Files": {
			initialCount: Infinity,
			incrementCount: 100,
		},
		"Queued Files": {
			initialCount: 10,
			incrementCount: 100,
		},
		"Completed Files": {
			initialCount: 5,
			incrementCount: 100,
		},
		default: {
			initialCount: Infinity,
			incrementCount: 100,
		},
	};

	const expandedCounts = writable<Record<string, number>>({});

	interface VisibleStateResult {
		visibleCount: number;
		visibleDocs: DocumentState[];
		remainingCount: number;
	}

	const visibleState = derived(expandedCounts, ($expandedCounts) => (group) => {
		const config = groupConfigs[group.title] || groupConfigs.default;
		const visibleCount = $expandedCounts[group.title] || config.initialCount;
		const visibleDocs = group.documents.slice(0, visibleCount);
		const remainingCount = group.documents.length - visibleCount;
		return {
			visibleCount,
			visibleDocs,
			remainingCount,
		} as VisibleStateResult;
	});

	function showMore(groupTitle: string) {
		const config = groupConfigs[groupTitle] || groupConfigs.default;
		expandedCounts.update((counts) => ({
			...counts,
			[groupTitle]:
				(counts[groupTitle] || config.initialCount) + config.incrementCount,
		}));
	}

	function formatRemainingCount(count: number): string {
		return new Intl.NumberFormat().format(count);
	}

	interface DocumentState {
		guid: string;
		path: string;
		doc: Document;
		origin: "local" | "remote" | "unknown";
		serverSynced: boolean;
		queueState?: {
			status: "running" | "pending" | "failed" | "completed";
			type: "sync" | "download";
			error?: string;
			timestamp: number;
		};
	}

	interface FolderState {
		folder: SharedFolder;
		documents: DocumentState[];
		progress?: number;
	}

	async function getFolderState(folder: SharedFolder): Promise<FolderState> {
		const documents: DocumentState[] = [];
		const docs: Document[] = Array.from(folder.docs.values());

		for (const doc of docs) {
			const origin = await doc.getOrigin();
			const serverSynced = await doc.getServerSynced();

			const state: DocumentState = {
				guid: doc.guid,
				path: folder.getPath(doc.path),
				doc,
				origin: origin || "unknown",
				serverSynced,
			};

			const syncItem = Array.from(activeSyncs).find((i) => i.guid === doc.guid);
			const downloadItem = Array.from(activeDownloads).find(
				(i) => i.guid === doc.guid,
			);
			const logItem = syncLog.find((i) => i.guid === doc.guid);

			if (syncItem || downloadItem || logItem) {
				const item = syncItem || downloadItem || logItem;
				state.queueState = {
					status: item.status,
					type: "type" in item ? item.type : "sync",
					error: "error" in item ? item.error : undefined,
					timestamp: "timestamp" in item ? item.timestamp : Date.now(),
				};
			} else if (origin === "local" && !serverSynced) {
				state.queueState = {
					status: "pending",
					type: "sync",
					timestamp: Date.now(),
				};
			} else if (serverSynced) {
				state.queueState = {
					status: "completed",
					type: "sync",
					timestamp: Date.now(),
				};
			} else {
				state.queueState = {
					status: "pending",
					type: "sync",
					timestamp: Date.now(),
				};
			}

			documents.push(state);
		}

		return {
			folder,
			documents,
			progress: backgroundSync.getGroupProgress(folder)?.percent || 0,
		};
	}

	function getStatusDisplay(item: DocumentState) {
		const { origin, serverSynced, queueState } = item;
		const status = queueState?.status || "completed";
		const type = queueState?.type || "sync";

		if (
			origin === "remote" &&
			!serverSynced &&
			status === "running" &&
			type === "download"
		) {
			return {
				text: "Downloading",
				description: "Initial acquisition",
				icon: Download,
				iconClass: "mod-primary",
			};
		}
		if (
			origin === "remote" &&
			!serverSynced &&
			status === "pending" &&
			type === "download"
		) {
			return {
				text: "Queued for Download",
				description: "Waiting to download",
				icon: Clock,
				iconClass: "",
			};
		}
		if (
			origin === "remote" &&
			!serverSynced &&
			status === "failed" &&
			type === "download"
		) {
			return {
				text: "Download stuck",
				description: "Needs retry",
				icon: AlertTriangle,
				iconClass: "mod-warning",
			};
		}
		if (
			origin === "local" &&
			!serverSynced &&
			status === "running" &&
			type === "sync"
		) {
			return {
				text: "Uploading",
				description: "First-time upload",
				icon: Upload,
				iconClass: "mod-primary",
			};
		}
		if (
			origin === "local" &&
			!serverSynced &&
			status === "pending" &&
			type === "sync"
		) {
			return {
				text: "Queued for Upload",
				description: "Waiting to upload",
				icon: Clock,
				iconClass: "",
			};
		}
		if (
			origin === "local" &&
			!serverSynced &&
			status === "failed" &&
			type === "sync"
		) {
			return {
				text: "Upload stuck",
				description: "Needs retry",
				icon: AlertTriangle,
				iconClass: "mod-warning",
			};
		}
		if (serverSynced && status === "running" && type === "sync") {
			return {
				text: "Syncing",
				description: "Collaborative update",
				icon: ArrowUpDown,
				iconClass: "mod-primary",
			};
		}
		if (serverSynced && status === "pending" && type === "sync") {
			return {
				text: "Queued for Sync",
				description: "Waiting to sync",
				icon: Clock,
				iconClass: "",
			};
		}
		if (serverSynced && status === "failed" && type === "sync") {
			return {
				text: "Sync stuck",
				description: "Needs retry",
				icon: AlertTriangle,
				iconClass: "mod-warning",
			};
		}
		if (serverSynced && status === "completed") {
			return {
				text: "Complete",
				description: "Fully synchronized",
				icon: CheckCircle,
				iconClass: "mod-success",
			};
		}

		return {
			text: "Unknown",
			description: "Status unknown",
			icon: Info,
			iconClass: "",
		};
	}

	function getRelativeTime(timestamp: number): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diffInMs = now.getTime() - date.getTime();
		const diffInMinutes = Math.floor(diffInMs / (1000 * 60));

		if (diffInMinutes < 1) return "just now";
		if (diffInMinutes === 1) return "1 minute ago";
		if (diffInMinutes < 60) return `${diffInMinutes} minutes ago`;

		const diffInHours = Math.floor(diffInMinutes / 60);
		if (diffInHours === 1) return "1 hour ago";
		if (diffInHours < 24) return `${diffInHours} hours ago`;

		const diffInDays = Math.floor(diffInHours / 24);
		if (diffInDays === 1) return "yesterday";
		return `${diffInDays} days ago`;
	}

	function groupDocuments(documents: DocumentState[]) {
		const active = documents.filter((d) => d.queueState?.status === "running");
		const stuck = documents.filter((d) => d.queueState?.status === "failed");
		const queued = documents.filter((d) => d.queueState?.status === "pending");
		const completed = documents.filter(
			(d) => d.queueState?.status === "completed",
		);

		return [
			active.length > 0 && { title: "Active Files", documents: active },
			stuck.length > 0 && { title: "Stuck Files", documents: stuck },
			queued.length > 0 && { title: "Queued Files", documents: queued },
			completed.length > 0 && {
				title: "Completed Files",
				documents: completed,
			},
		].filter(Boolean);
	}

	async function retryOperation(doc: DocumentState) {
		const logEntry = {
			id: doc.guid,
			guid: doc.guid,
			path: doc.path,
			timestamp: doc.queueState?.timestamp || Date.now(),
			type: doc.queueState?.type || "sync",
			status: "failed" as "failed",
			sharedFolderGuid: doc.doc.sharedFolder.guid,
		};
		await backgroundSync.retryLogItem(logEntry);
	}

	$: folderState = getFolderState(folder);
</script>

{#await folderState}
	<div class="loading">Loading...</div>
{:then state}
	{#each groupDocuments(state.documents) as group}
		<SettingItemHeading name={group.title} />

		{#each $visibleState(group).visibleDocs as doc}
			<SlimSettingItem>
				<span slot="name" class="file-name">
					<svelte:component
						this={getStatusDisplay(doc).icon}
						size={16}
						class="svg-icon {getStatusDisplay(doc).iconClass}"
					/>
					<span>{doc.path.split("/").pop()}</span>
				</span>

				<slot>
					<div class="details-container">
						<span class="details">
							{getStatusDisplay(doc).text}
							{#if doc.queueState?.timestamp}
								• {getRelativeTime(doc.queueState.timestamp)}
							{/if}
							{#if doc.queueState?.error}
								<div class="error-message">{doc.queueState.error}</div>
							{/if}
						</span>
					</div>

					{#if doc.queueState?.status === "failed"}
						<button class="mod-warning" on:click={() => retryOperation(doc)}>
							<RefreshCw size={14} class="svg-icon lucide-refresh-cw" />
							Retry
						</button>
					{/if}
				</slot>
			</SlimSettingItem>
		{/each}

		{#if $visibleState(group).remainingCount > 0}
			<SlimSettingItem>
				<span slot="name" class="more-files">
					...and {formatRemainingCount($visibleState(group).remainingCount)} more
					{group.title.toLowerCase()}
					<span
						class="show-more-link"
						on:click={() => {
							showMore(group.title);
						}}
						on:keydown={(e) => e.key === "Enter" && showMore(group.title)}
						role="button"
						tabindex="0"
						aria-label={`Show ${groupConfigs[group.title]?.incrementCount || groupConfigs.default.incrementCount} more ${group.title.toLowerCase()}`}
						>(show more)</span
					>
				</span>
			</SlimSettingItem>
		{/if}
	{/each}
{/await}

<style>
	.file-name {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.9rem;
		flex: 1;
		min-width: 0;
	}

	.details-container {
		margin-left: auto;
		text-align: right;
		padding-left: 8px;
		padding-right: 8px;
	}

	.details {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.error-message {
		color: var(--text-error);
		margin-top: 2px;
		text-align: right;
	}

	.more-files {
		font-size: 0.8rem;
		color: var(--text-muted);
		text-align: center;
	}

	button.mod-warning {
		display: flex;
		align-items: center;
		gap: 4px;
		background-color: var(--background-modifier-error);
		color: var(--text-error);
	}

	:global(.mod-primary) {
		color: var(--interactive-accent);
	}

	:global(.mod-success) {
		color: var(--interactive-success);
	}

	:global(.mod-warning) {
		color: var(--text-warning);
	}

	.show-more-link {
		color: var(--text-accent);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.show-more-link:hover {
		text-decoration: underline;
	}
</style>
