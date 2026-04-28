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
		Pencil,
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
			} else if (sp === "idle.error") {
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

	// ── Summary counts (from syncStatus map) ───────────────────────────

	let syncedCount = 0;
	let editingCount = 0;
	let syncingCount = 0;
	let conflictCount = 0;
	let errorCount = 0;

	function refreshCounts() {
		let synced = 0, editing = 0, syncing = 0, conflict = 0, error = 0;
		for (const [guid, file] of sharedFolder.files) {
			const doc = file as any;
			const hsm = doc.hsm;
			if (hsm) {
				const sp: StatePath = hsm.statePath;
				const ss = hsm.getSyncStatus?.() as SyncStatus | undefined;
				const hasConflict = hasConflictStatus(ss) || hsm.getConflictData();
				const isEditing =
					sp.startsWith("active.entering") || sp.startsWith("active.tracking");
				const isSynced =
					sp === "idle.synced" || sp.startsWith("active.tracking");

				if (hasConflict) conflict++;
				if (isEditing) editing++;
				if (isSynced) synced++;
				if (sp === "idle.error") error++;
				if (!hasConflict && !isEditing && !isSynced && sp !== "idle.error") {
					syncing++;
				}
			} else {
				const ss = sharedFolder.mergeManager.syncStatus.get<SyncStatus>(guid);
				if (!ss || ss.status === "synced") synced++;
				else if (ss.status === "pending") syncing++;
				else if (hasConflictStatus(ss)) conflict++;
				else if (ss.status === "error") error++;
			}
		}
		syncedCount = synced;
		editingCount = editing;
		syncingCount = syncing;
		conflictCount = conflict;
		errorCount = error;
	}

	// ── Activity log ───────────────────────────────────────────────────

	let activityLog: SyncStatusActivityEntry[] = [];
	$: visibleActivity = activityLog.filter(
		(e) => e.status !== "conflict" && e.author !== "you",
	);

	// ── Lifecycle ──────────────────────────────────────────────────────

	refreshActionable();
	refreshCounts();

	const unsubscribeActivity = activityStore.subscribe((entries) => {
		activityLog = entries;
	});

	const unsubscribeSyncStatus = sharedFolder.mergeManager.syncStatus.subscribe(() => {
		refreshActionable();
		refreshCounts();
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
	<div class="sync-status-summary">
		{#if syncedCount > 0}
			<span class="sync-status-badge synced">
				<CheckCircle size={14} /> {syncedCount} synced
			</span>
		{/if}
		{#if editingCount > 0}
			<span class="sync-status-badge editing">
				<Pencil size={14} /> {editingCount} editing
			</span>
		{/if}
		{#if syncingCount > 0}
			<span class="sync-status-badge syncing">
				<Loader size={14} /> {syncingCount} syncing
			</span>
		{/if}
		{#if conflictCount > 0}
			<span class="sync-status-badge conflict">
				<AlertTriangle size={14} /> {conflictCount} conflict{conflictCount !== 1 ? "s" : ""}
			</span>
		{/if}
		{#if errorCount > 0}
			<span class="sync-status-badge error">
				<XCircle size={14} /> {errorCount} error{errorCount !== 1 ? "s" : ""}
			</span>
		{/if}
	</div>

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

	.sync-status-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		padding: 8px 0 16px;
		border-bottom: 1px solid var(--background-modifier-border);
		margin-bottom: 12px;
	}

	.sync-status-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--font-ui-small);
		color: var(--text-muted);
	}

	.sync-status-badge.conflict {
		color: var(--text-warning);
	}

	.sync-status-badge.error {
		color: var(--text-error);
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
		grid-template-columns: auto 1fr;
		grid-template-areas:
			"icon path"
			"icon meta";
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
