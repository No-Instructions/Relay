<script lang="ts">
	import { onDestroy } from "svelte";
	import { TFile, type App } from "obsidian";
	import type { SharedFolder } from "../SharedFolder";
	import type { StatePath } from "../merge-hsm/types";
	import type { SyncStatus } from "../merge-hsm/types";
	import type { TimeProvider } from "../TimeProvider";
	import type {
		SyncStatusActivityEntry,
		SyncStatusActivityStore,
	} from "../ui/SyncStatusActivity";
	import {
		CheckCircle,
		AlertTriangle,
		Loader,
		XCircle,
		X,
		GitMerge,
	} from "lucide-svelte";

	export let sharedFolder: SharedFolder;
	export let app: App;
	export let timeProvider: TimeProvider;
	export let activityStore: SyncStatusActivityStore;

	// ── Actionable items (from HSM state) ──────────────────────────────

	interface ActionableFile {
		guid: string;
		path: string;
		category: "conflict" | "error";
		label: string;
	}

	let actionableFiles: ActionableFile[] = [];
	let dismissedErrors = new Set<string>();

	function hasConflictStatus(status: SyncStatus | undefined): boolean {
		return status?.status === "conflict";
	}

	function refreshActionable() {
		const result: ActionableFile[] = [];
		for (const [guid, file] of sharedFolder.files) {
			const doc = file as any;
			const hsm = doc.hsm;
			if (!hsm) continue;
			const sp: StatePath = hsm.statePath;
			const ss = hsm.getSyncStatus?.() as SyncStatus | undefined;
			if (hasConflictStatus(ss)) {
				result.push({
					guid,
					path: file.path,
					category: "conflict",
					label: sp === "active.conflict.resolving" ? "Resolving" : "Conflict detected",
				});
			} else if (hsm.getConflictData()) {
				result.push({
					guid,
					path: file.path,
					category: "conflict",
					label: "Conflict detected",
				});
			} else if (sp === "idle.error" && !dismissedErrors.has(guid)) {
				result.push({
					guid,
					path: file.path,
					category: "error",
					label: "Error",
				});
			}
		}
		result.sort((a, b) => a.path.localeCompare(b.path));
		actionableFiles = result;
	}

	$: conflicts = actionableFiles.filter((f) => f.category === "conflict");
	$: errors = actionableFiles.filter((f) => f.category === "error");

	// ── Activity log ───────────────────────────────────────────────────

	let activityLog: SyncStatusActivityEntry[] = [];
	$: visibleActivity = activityLog.filter(
		(e) => e.status !== "conflict" && e.author !== "you",
	);

	// ── Lifecycle ──────────────────────────────────────────────────────

	refreshActionable();

	const unsubscribeActivity = activityStore.subscribe((entries) => {
		activityLog = entries;
	});

	const unsubscribeSyncStatus = sharedFolder.mergeManager.syncStatus.subscribe(() => {
		refreshActionable();
	});

	onDestroy(() => {
		unsubscribeActivity();
		unsubscribeSyncStatus();
	});

	// ── Helpers ─────────────────────────────────────────────────────────

	function getVaultFile(filePath: string): TFile | null {
		// `filePath` may be either a `/foo/bar.md` virtual path (conflicts/errors
		// entries) or a pre-relativized path (activity entries). Normalise to
		// absolute vault path.
		const normalized = filePath.startsWith("/") ? filePath : "/" + filePath;
		const vaultPath = (sharedFolder.path + normalized).replace(/^\/+/, "");
		const abstractFile = app.vault.getAbstractFileByPath(vaultPath);
		return abstractFile instanceof TFile ? abstractFile : null;
	}

	function openFile(filePath: string) {
		const file = getVaultFile(filePath);
		if (file) {
			app.workspace.getLeaf().openFile(file);
		}
	}

	function dismissError(guid: string, event: MouseEvent) {
		event.stopPropagation();
		dismissedErrors = new Set(dismissedErrors).add(guid);
		refreshActionable();
	}

	function fileLabel(filePath: string): string {
		const file = getVaultFile(filePath);
		if (!file) return stripMarkdownExtension(relativePath(filePath));
		return app.metadataCache.fileToLinktext(file, sharedFolder.path, true);
	}

	function handlePathKeydown(event: KeyboardEvent, filePath: string) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			openFile(filePath);
		}
	}

	function stripMarkdownExtension(path: string): string {
		return path.endsWith(".md") ? path.slice(0, -3) : path;
	}

	function relativePath(fullPath: string): string {
		if (fullPath.startsWith("/")) {
			return fullPath.slice(1);
		}
		if (fullPath.startsWith(sharedFolder.path + "/")) {
			return fullPath.slice(sharedFolder.path.length + 1);
		}
		return fullPath;
	}

	let now = timeProvider.now();
	const tickInterval = timeProvider.setInterval(() => { now = timeProvider.now(); }, 1_000);
	onDestroy(() => timeProvider.clearInterval(tickInterval));

	function timeAgo(timestamp: number, _now: number): string {
		const seconds = Math.floor((_now - timestamp) / 1000);
		if (seconds < 10) return "just now";
		if (seconds < 60) return "a few seconds ago";
		const minutes = Math.floor(seconds / 60);
		if (minutes === 1) return "1 minute ago";
		if (minutes < 60) return `${minutes} minutes ago`;
		const hours = Math.floor(minutes / 60);
		if (hours === 1) return "1 hour ago";
		return `${hours} hours ago`;
	}
</script>

<div class="sync-status-modal">
	{#if conflicts.length > 0}
		<div class="sync-status-section">
			<div class="sync-status-section-header">Conflicts ({conflicts.length})</div>
			{#each conflicts as file}
				<div class="sync-status-row">
					<span class="sync-status-icon conflict"><AlertTriangle size={14} /></span>
					<span
						class="sync-status-path"
						role="link"
						tabindex="0"
						on:click={() => openFile(file.path)}
						on:keydown={(e) => handlePathKeydown(e, file.path)}
					>{fileLabel(file.path)}</span>
					<div class="sync-status-meta">
						<span class="sync-status-state">{file.label}</span>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if errors.length > 0}
		<div class="sync-status-section">
			<div class="sync-status-section-header">Errors ({errors.length})</div>
			{#each errors as file}
				<div class="sync-status-row">
					<span class="sync-status-icon error"><XCircle size={14} /></span>
					<span
						class="sync-status-path"
						role="link"
						tabindex="0"
						on:click={() => openFile(file.path)}
						on:keydown={(e) => handlePathKeydown(e, file.path)}
					>{fileLabel(file.path)}</span>
					<button
						class="sync-status-dismiss"
						type="button"
						aria-label="Dismiss error"
						on:click={(e) => dismissError(file.guid, e)}
					>
						<X size={14} />
					</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if visibleActivity.length > 0}
		<div class="sync-status-section">
			<div class="sync-status-section-header">Recent Activity</div>
			{#each visibleActivity as entry (entry.id)}
				<div class="sync-status-row activity-row">
					<span class="sync-status-icon activity">
						{#if entry.status === "synced"}
							<CheckCircle size={14} />
						{:else if entry.status === "pending"}
							<Loader size={14} />
						{:else if entry.status === "conflict"}
							<AlertTriangle size={14} />
						{:else if entry.status === "error"}
							<XCircle size={14} />
						{:else}
							<GitMerge size={14} />
						{/if}
					</span>
					<span
						class="sync-status-path"
						role="link"
						tabindex="0"
						on:click={() => openFile(entry.path)}
						on:keydown={(e) => handlePathKeydown(e, entry.path)}
					>{fileLabel(entry.path)}</span>
					<div class="sync-status-meta">
						{#if entry.author}
							<span class="sync-status-author">{entry.author}</span>
						{/if}
						<span class="sync-status-time">{timeAgo(entry.timestamp, now)}</span>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if conflicts.length === 0 && errors.length === 0 && visibleActivity.length === 0}
		<div class="sync-status-empty">Activity will appear here as files sync.</div>
	{/if}
</div>

<style>
	.sync-status-modal {
		padding: 8px 0;
	}

	.sync-status-section {
		margin-bottom: 12px;
	}

	.sync-status-section-header {
		font-size: var(--font-ui-small);
		font-weight: var(--font-semibold);
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 4px 0;
		border-bottom: 1px solid var(--background-modifier-border);
		margin-bottom: 4px;
	}

	.sync-status-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas:
			"icon path action"
			"icon meta action";
		column-gap: 8px;
		row-gap: 2px;
		align-items: baseline;
		padding: 4px 0;
	}

	.sync-status-icon {
		grid-area: icon;
		display: inline-flex;
		flex-shrink: 0;
		align-self: center;
	}

	.sync-status-icon.conflict {
		color: var(--text-warning);
	}

	.sync-status-icon.error {
		color: var(--text-error);
	}

	.sync-status-icon.activity {
		color: var(--text-muted);
	}

	.activity-row {
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas: "icon path meta";
		align-items: center;
	}

	.activity-row :global(.sync-status-icon.activity svg) {
		opacity: 0.7;
	}

	.sync-status-path {
		grid-area: path;
		color: var(--nav-item-color, var(--text-normal));
		font-size: var(--nav-item-size, var(--font-ui-small));
		font-weight: var(--nav-item-weight, var(--font-normal));
		overflow-wrap: break-word;
		line-height: var(--line-height-tight);
		min-width: 0;
	}

	.sync-status-path[role="link"] {
		cursor: pointer;
		text-decoration: none;
	}

	.sync-status-path[role="link"]:hover {
		color: var(--nav-item-color-hover, var(--text-normal));
	}

	.sync-status-path[role="link"]:focus-visible {
		outline: 1px solid var(--background-modifier-border-focus);
		outline-offset: 2px;
	}

	.sync-status-meta {
		grid-area: meta;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		font-size: var(--font-ui-smaller);
		color: var(--text-faint);
		align-items: baseline;
	}

	.sync-status-dismiss {
		grid-area: action;
		align-self: center;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.sync-status-dismiss:hover {
		color: var(--text-normal);
	}

	.activity-row .sync-status-meta {
		flex-direction: column;
		align-items: flex-end;
		gap: 0;
		line-height: 1.2;
		min-width: max-content;
	}

	.sync-status-state {
		white-space: nowrap;
	}

	.sync-status-author {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.sync-status-time {
		white-space: nowrap;
		margin-left: auto;
	}

	.activity-row .sync-status-time {
		margin-left: 0;
	}

	.sync-status-empty {
		text-align: center;
		color: var(--text-faint);
		padding: 24px 0;
	}
</style>
