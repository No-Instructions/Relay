<script lang="ts">
	import type Live from "../main";
	import { onMount } from "svelte";
	import { writable } from "svelte/store";
	import type { DBSummaryStats, StoreAnalysis } from "../DatabaseTools";
	import { analyzeIndexedDB, deleteBySlug } from "../DatabaseTools";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { setIcon } from "obsidian";

	export let plugin: Live;
	const isLoading = writable(true);
	const progress = writable(0);
	const stats = writable<DBSummaryStats | null>(null);
	const error = writable<string | null>(null);
	let searchAcrossVaults = false;

	// Group stores by relay (only for large stores)
	$: groupedStores =
		$stats?.largeStores.reduce(
			(groups, store) => {
				const relayGroup = store.relay || "local";
				if (!groups[relayGroup]) {
					groups[relayGroup] = [];
				}
				groups[relayGroup].push(store);
				return groups;
			},
			{} as Record<string, StoreAnalysis[]>,
		) ?? {};

	async function analyzeStores() {
		isLoading.set(true);
		error.set(null);
		try {
			const results = await analyzeIndexedDB({
				appId: plugin.appId,
				filterByAppId: !searchAcrossVaults,
				onProgress: (p) => progress.set(p),
			});
			stats.set(results);
		} catch (e) {
			error.set(`Analysis failed: ${e.message}`);
		} finally {
			isLoading.set(false);
		}
	}

	// Sort relay groups for consistent display
	$: sortedRelayGroups = Object.entries(groupedStores).sort(([a], [b]) => {
		if (a === "local") return -1;
		if (b === "local") return 1;
		return a.localeCompare(b);
	});

	async function handleDelete(slug: string) {
		try {
			await deleteBySlug(slug);
			if ($stats) {
				$stats.largeStores = $stats.largeStores.filter(
					(store) => store.slug !== slug,
				);
			}
		} catch (e) {
			error.set(`Failed to delete ${slug}: ${e.message}`);
		}
	}

	onMount(() => {
		analyzeStores();
	});
</script>

<div class="modal-title">Relay database analysis</div>
<div class="system3-indexeddb-analysis">
	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Search across vaults</div>
			<div class="setting-item-description">
				<div class="mod-warning">
					Warning: This is a dangerous setting. It allows you to delete relay
					databases from other vaults.
				</div>
			</div>
		</div>
		<div class="setting-item-control">
			<div
				role="checkbox"
				aria-checked={searchAcrossVaults}
				tabindex="0"
				on:keypress={() => {
					searchAcrossVaults = !searchAcrossVaults;
					analyzeStores();
				}}
				class="checkbox-container system3-dangerous"
				class:is-enabled={searchAcrossVaults}
				on:click={() => {
					searchAcrossVaults = !searchAcrossVaults;
					analyzeStores();
				}}
			>
				<input type="checkbox" tabindex="-1" checked={searchAcrossVaults} />
				<div class="checkbox-toggle" />
			</div>
		</div>
	</div>

	{#if $isLoading}
		<div class="system3-loading-container">
			<div class="system3-loading-spinner" />
			<div class="loading-text">Analyzing Databases...</div>
			<div class="system3-progress-bar">
				<div class="system3-progress-fill" style="width: {$progress}%" />
			</div>
		</div>
	{:else if $error}
		<div class="system3-error-message">
			{$error}
		</div>
	{:else if $stats}
		<div class="system3-summary-stats">
			<div class="system3-stat-item system3-global-count">
				<div class="system3-stat-label">Global Database Limit</div>
				<div
					class="system3-stat-value"
					class:system3-warning={$stats.databaseCount > 40000}
					class:system3-critical={$stats.databaseCount > 45000}
				>
					{$stats.databaseCount.toLocaleString()} / 50,000
				</div>
				{#if $stats.databaseCount > 45000}
					<div class="system3-warning-text system3-critical">
						Critical: approaching IndexedDB database limit!<br />
						Your browser may start deleting old databases soon.
					</div>
				{:else if $stats.databaseCount > 40000}
					<div class="system3-warning-text">
						Warning: high number of databases.<br />
						Consider cleaning up unused databases.
					</div>
				{/if}
			</div>
			<div class="system3-stat-item">
				<div class="system3-stat-label">Relay Databases</div>
				<div class="system3-stat-value">{$stats.totalStores}</div>
			</div>
			<div class="system3-stat-item">
				<div class="system3-stat-label">Document Updates</div>
				<div class="system3-stat-value">
					{$stats.totalItems.toLocaleString()}
				</div>
			</div>
			<div class="system3-stat-item">
				<div class="system3-stat-label">Total Size</div>
				<div class="system3-stat-value">{$stats.totalSizeMB.toFixed(2)} MB</div>
			</div>
		</div>

		{#if $stats.largeStores.length > 0}
			<SettingItemHeading name="Large Stores (>1MB)" />
			{#each sortedRelayGroups as [relay, relayStores]}
				<SettingItemHeading
					name={relay === "local" ? "Tracked Documents" : `Relay: ${relay}`}
				/>
				{#each relayStores as store}
					<SettingItem
						name={store.path || store.slug}
						description="Size: {store.estimatedSizeMB}MB, Items: {store.count}"
					>
						<div class="system3-actions">
							<button
								class="mod-warning"
								on:click={() => handleDelete(store.slug)}
								title="Delete all data in this store"
							>
								Delete
							</button>
						</div>
					</SettingItem>
				{/each}
			{/each}
		{/if}
	{/if}
</div>

<style>
	.system3-dangerous:enabled {
		background-color: var(--background-modifier-error);
	}
	.system3-indexeddb-analysis {
		padding: 1rem;
		max-height: 500px;
		overflow-y: auto;
	}

	.system3-loading-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 200px;
		gap: 1rem;
	}

	.system3-loading-spinner {
		border: 4px solid var(--background-modifier-border);
		border-top: 4px solid var(--interactive-accent);
		border-radius: 50%;
		width: 40px;
		height: 40px;
		animation: spin 1s linear infinite;
	}

	.system3-progress-bar {
		width: 80%;
		height: 8px;
		border-radius: 4px;
		background-color: var(--background-secondary);
		overflow: hidden;
		margin: 0 auto;
	}

	.system3-progress-fill {
		height: 100%;
		background-color: var(--color-accent);
		border-radius: 4px;
		transition: width 0.3s ease;
		min-width: 0%;
		max-width: 100%;
	}

	.system3-error-message {
		color: var(--text-error);
		padding: 1rem;
		background-color: var(--mod-error);
		border-radius: 4px;
	}

	.system3-actions {
		display: flex;
		gap: 0.5rem;
	}

	.system3-summary-stats {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
		margin-bottom: 2rem;
		padding: 1rem;
		background-color: var(--background-secondary);
		border-radius: 4px;
	}

	.system3-stat-item {
		text-align: center;
	}

	.system3-global-count {
		grid-column: 1 / -1;
		padding-top: 0.5rem;
		margin-top: 0.5rem;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.system3-warning {
		color: var(--text-warning);
	}

	.system3-critical {
		color: var(--text-error);
	}

	.system3-warning-text {
		font-size: 0.8em;
		margin-top: 0.5rem;
		color: var(--text-warning);
		line-height: 1.4;
	}

	.system3-warning-text.system3-critical {
		color: var(--text-error);
		font-weight: bold;
	}

	.system3-stat-label {
		font-size: 0.9em;
		color: var(--text-muted);
		margin-bottom: 0.5rem;
	}

	.system3-stat-value {
		font-size: 1.2em;
		font-weight: bold;
	}

	@keyframes spin {
		0% {
			transform: rotate(0deg);
		}
		100% {
			transform: rotate(360deg);
		}
	}
</style>
