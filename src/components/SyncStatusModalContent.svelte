<script lang="ts">
	import { onDestroy } from "svelte";
	import { TFile, type App } from "obsidian";
	import type { SharedFolder } from "../SharedFolder";
	import type { StatePath } from "../merge-hsm/types";
	import type { SyncStatus } from "../merge-hsm/types";
	import type { TimeProvider } from "../TimeProvider";
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

	const MAX_ACTIVITY = 30;

	// ── Author tracking (from CBOR events) ─────────────────────────────

	const lastAuthorByGuid = new Map<string, string>();
	const localUserId = (sharedFolder as any).loginManager?.user?.id as string | undefined;

	function resolveAuthorName(userId: string | undefined): string {
		if (!userId) return "";
		if (userId === localUserId) return "you";
		// Try awareness for display name
		const provider = sharedFolder._provider;
		if (provider?.awareness) {
			for (const [, state] of provider.awareness.getStates()) {
				const user = state?.user;
				if (user?.id === userId && user?.name) {
					return user.name;
				}
			}
		}
		return userId.slice(0, 8);
	}

	function extractGuidFromDocId(docId: string): string | null {
		const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
		const match = docId.match(new RegExp(`^${uuidPattern}-(${uuidPattern})$`, "i"));
		return match ? match[1] : null;
	}

	// Guids that received CBOR events since last recordActivity() call
	const recentCborGuids = new Map<string, string | undefined>();

	function handleCborEvent(event: any) {
		const guid = extractGuidFromDocId(event.doc_id ?? "");
		if (!guid || !sharedFolder.files.has(guid)) return;
		// Skip own-user echoes — the server echoes back our own updates.
		// Without this filter, local edits get attributed to "you" in the
		// activity log, overwriting the correct remote author.
		if (event.user && event.user === localUserId) return;
		if (event.user) {
			lastAuthorByGuid.set(guid, event.user);
		}
		recentCborGuids.set(guid, event.user);
	}

	const provider = sharedFolder._provider;
	if (provider) {
		provider.subscribeToEvents(["document.updated"], handleCborEvent);
	}

	// ── Actionable items (from HSM state) ──────────────────────────────

	interface ActionableFile {
		guid: string;
		path: string;
		category: "conflict" | "error";
		label: string;
	}

	let actionableFiles: ActionableFile[] = [];

	function refreshActionable() {
		const result: ActionableFile[] = [];
		for (const [guid, file] of sharedFolder.files) {
			const doc = file as any;
			const hsm = doc.hsm;
			if (!hsm) continue;
			const sp: StatePath = hsm.statePath;
			if (sp === "active.conflict.bannerShown" || sp === "active.conflict.resolving") {
				result.push({ guid, path: file.path, category: "conflict", label: sp === "active.conflict.resolving" ? "Resolving" : "Conflict detected" });
			} else if (hsm.getConflictData()) {
				result.push({ guid, path: file.path, category: "conflict", label: "Conflict detected" });
			} else if (sp === "idle.error") {
				result.push({ guid, path: file.path, category: "error", label: "Error" });
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
				if (sp.startsWith("active.conflict") || hsm.getConflictData()) conflict++;
				else if (sp === "idle.synced") synced++;
				else if (sp === "active.tracking" || sp.startsWith("active.entering")) editing++;
				else if (sp === "idle.error") error++;
				else syncing++;
			} else {
				const ss = sharedFolder.mergeManager.syncStatus.get<SyncStatus>(guid);
				if (!ss || ss.status === "synced") synced++;
				else if (ss.status === "pending") syncing++;
				else if (ss.status === "conflict") conflict++;
				else if (ss.status === "error") error++;
			}
		}
		syncedCount = synced;
		editingCount = editing;
		syncingCount = syncing;
		conflictCount = conflict;
		errorCount = error;
	}

	// ── Activity log (coalesced per file, from syncStatus notifications) ─

	interface ActivityEntry {
		guid: string;
		path: string;
		timestamp: number;
		status: string;
		description: string;
		author: string;
	}

	// One entry per file, keyed by guid, sorted by most recent
	let activityMap = new Map<string, ActivityEntry>();
	let activityLog: ActivityEntry[] = [];

	// Track previous syncStatus snapshot to detect which guids changed
	let prevSnapshot = new Map<string, string>();

	function guidToPath(guid: string): string {
		const file = sharedFolder.files.get(guid);
		return file ? relativePath(file.path) : guid.slice(0, 8);
	}

	function describeStatus(status: string): string {
		switch (status) {
			case "synced": return "Synced";
			case "pending": return "Syncing";
			case "conflict": return "Conflict detected";
			case "error": return "Error";
			default: return status;
		}
	}

	function recordActivity() {
		const ts = timeProvider.now();
		const syncStatusMap = sharedFolder.mergeManager.syncStatus;
		let changed = false;

		for (const [guid] of sharedFolder.files) {
			const ss = syncStatusMap.get<SyncStatus>(guid);
			const currentStatus = ss?.status ?? "unknown";
			const prevStatus = prevSnapshot.get(guid) ?? "unknown";

			if (currentStatus !== prevStatus && prevStatus !== "unknown") {
				activityMap.set(guid, {
					guid,
					path: guidToPath(guid),
					timestamp: ts,
					status: currentStatus,
					description: describeStatus(currentStatus),
					author: resolveAuthorName(lastAuthorByGuid.get(guid)),
				});
				changed = true;
			}

			prevSnapshot.set(guid, currentStatus);
		}

		// Also log CBOR-triggered files that may have synced too fast to show a status change.
		// If we got a CBOR event for a guid since last check, log it even if status didn't change.
		for (const [guid, userId] of recentCborGuids) {
			if (!activityMap.has(guid) || activityMap.get(guid)!.timestamp < ts - 5000) {
				const ss = syncStatusMap.get<SyncStatus>(guid);
				activityMap.set(guid, {
					guid,
					path: guidToPath(guid),
					timestamp: ts,
					status: ss?.status ?? "synced",
					description: "Synced",
					author: resolveAuthorName(userId),
				});
				changed = true;
			}
		}
		recentCborGuids.clear();

		if (changed) {
			const sorted = [...activityMap.values()].sort((a, b) => b.timestamp - a.timestamp);
			if (sorted.length > MAX_ACTIVITY) {
				for (const entry of sorted.slice(MAX_ACTIVITY)) {
					activityMap.delete(entry.guid);
				}
			}
			activityLog = sorted.slice(0, MAX_ACTIVITY);
		}
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	// Initialize snapshot without logging (don't flood with initial state)
	// Initialize snapshot without logging
	{
		const syncStatusMap = sharedFolder.mergeManager.syncStatus;
		for (const [guid] of sharedFolder.files) {
			const ss = syncStatusMap.get<SyncStatus>(guid);
			prevSnapshot.set(guid, ss?.status ?? "unknown");
		}
	}
	refreshActionable();
	refreshCounts();

	const unsub = sharedFolder.mergeManager.syncStatus.subscribe(() => {
		recordActivity();
		refreshActionable();
		refreshCounts();
	});

	onDestroy(() => {
		unsub();
	});

	// ── Helpers ─────────────────────────────────────────────────────────

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
					<span class="sync-status-path">{relativePath(file.path)}</span>
					<span class="sync-status-state">{file.label}</span>
					<button
						class="mod-cta"
						on:click={() => {
							const vaultPath = sharedFolder.path + file.path;
							const abstractFile = app.vault.getAbstractFileByPath(vaultPath);
							if (abstractFile && abstractFile instanceof TFile) {
								const leaf = app.workspace.getLeaf();
								leaf.openFile(abstractFile);
							}
						}}
					>Resolve</button>
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
					<span class="sync-status-path">{relativePath(file.path)}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if activityLog.length > 0}
		<div class="sync-status-section">
			<div class="sync-status-section-header">Recent Activity</div>
			{#each activityLog.filter(e => e.status !== "conflict") as entry (entry.guid)}
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
					<span class="sync-status-path">{entry.path}</span>
					{#if entry.author}
						<span class="sync-status-author">{entry.author}</span>
					{/if}
					<span class="sync-status-state">{entry.description}</span>
					<span class="sync-status-time">{timeAgo(entry.timestamp, now)}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if conflicts.length === 0 && errors.length === 0 && activityLog.length === 0}
		<div class="sync-status-empty">All files are synced. Activity will appear here as files sync.</div>
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
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
	}

	.sync-status-icon {
		display: inline-flex;
		flex-shrink: 0;
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

	.activity-row :global(.sync-status-icon.activity svg) {
		opacity: 0.7;
	}

	.sync-status-path {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--font-ui-small);
	}

	.sync-status-state {
		font-size: var(--font-ui-smaller);
		color: var(--text-faint);
		flex-shrink: 0;
		text-align: right;
		white-space: nowrap;
	}

	.sync-status-author {
		font-size: var(--font-ui-smaller);
		color: var(--text-accent);
		flex-shrink: 0;
		width: 100px;
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sync-status-time {
		font-size: var(--font-ui-smaller);
		color: var(--text-faint);
		flex-shrink: 0;
		width: 110px;
		text-align: right;
	}

	.sync-status-empty {
		text-align: center;
		color: var(--text-muted);
		padding: 24px 0;
	}

	button.mod-cta {
		flex-shrink: 0;
	}
</style>
