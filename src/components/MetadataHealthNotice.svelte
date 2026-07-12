<script lang="ts">
	import { onDestroy } from "svelte";
	import { AlertTriangle, X } from "lucide-svelte";
	import type {
		MetadataHealth,
		MetadataHealthState,
	} from "src/MetadataHealth";

	export let metadataHealth: MetadataHealth;

	let state: MetadataHealthState = metadataHealth.state;
	let dismissed = false;

	const unsubscribe = metadataHealth.subscribe((health) => {
		const next = health.state;
		if (state.status === "metadata-db-locked" && next.status !== "metadata-db-locked") {
			dismissed = false;
		}
		state = next;
	});

	onDestroy(() => {
		unsubscribe();
	});

	$: isLocked = state.status === "metadata-db-locked";
</script>

{#if isLocked && !dismissed}
	<div class="metadata-health-notice callout" data-callout="warning" role="status">
		<div class="callout-title metadata-health-title-row">
			<div class="callout-icon">
				<AlertTriangle size={14} />
			</div>
			<div class="callout-title-inner">Obsidian metadata database is locked</div>
			<button
				class="clickable-icon metadata-health-close"
				type="button"
				aria-label="Dismiss metadata database warning"
				on:click={() => {
					dismissed = true;
				}}
			>
				<X size={14} />
			</button>
		</div>
		<div class="callout-content metadata-health-detail">
			<p>
				Relay detected that Obsidian's metadata database is locked. Restart Obsidian
				to restore indexing.
			</p>
		</div>
	</div>
{/if}

<style>
	.metadata-health-notice {
		margin: 8px;
		padding: 8px 10px;
		font-size: var(--font-ui-small);
		line-height: 1.25;
	}

	.metadata-health-title-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 0;
	}

	.metadata-health-title-row .callout-icon {
		margin-top: 1px;
	}

	.metadata-health-title-row .callout-title-inner {
		flex: 1 1 auto;
		min-width: 0;
	}

	.metadata-health-detail {
		margin: 3px 0 0 22px;
		padding: 0;
	}

	.metadata-health-detail :global(p) {
		margin: 0;
	}

	.metadata-health-close {
		flex: 0 0 auto;
		width: 22px;
		height: 22px;
		margin: -4px -5px 0 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		box-shadow: none;
		text-shadow: none;
		filter: none;
		appearance: none;
		-webkit-appearance: none;
		cursor: var(--cursor);
	}

	.metadata-health-close:hover,
	.metadata-health-close:focus-visible,
	.metadata-health-close:active {
		box-shadow: none;
		text-shadow: none;
		filter: none;
	}
</style>
