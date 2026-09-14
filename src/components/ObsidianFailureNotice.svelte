<script lang="ts">
	import { AlertTriangle, X } from "lucide-svelte";

	export let active: boolean;
	export let title: string;
	export let dismissLabel: string;
	export let className = "";
	export let slotClass: string;
	let dismissed = false;
	$: if (!active) dismissed = false;
</script>

{#if active && !dismissed}
	<div class="system3-sidebar-notice-slot {slotClass}">
		<div class="{className} obsidian-failure-notice callout" data-callout="warning" role="status">
			<div class="callout-title obsidian-failure-title-row">
				<div class="callout-icon">
					<AlertTriangle size={14} />
				</div>
				<div class="callout-title-inner">{title}</div>
				<button
					class="clickable-icon obsidian-failure-close"
					type="button"
					aria-label={dismissLabel}
					on:click={() => {
						dismissed = true;
					}}
				>
					<X size={14} />
				</button>
			</div>
			<div class="callout-content obsidian-failure-detail">
				<p><slot /></p>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(.workspace-split) > .system3-sidebar-notice-slot {
		order: 1;
		flex: 0 0 auto;
		height: auto;
		min-height: 0;
		overflow: visible;
	}

	.obsidian-failure-notice {
		margin: 8px;
		padding: 8px 10px;
		font-size: var(--font-ui-small);
		line-height: 1.25;
	}

	.obsidian-failure-title-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 0;
	}

	.obsidian-failure-title-row .callout-icon {
		margin-top: 1px;
	}

	.obsidian-failure-title-row .callout-title-inner {
		flex: 1 1 auto;
		min-width: 0;
	}

	.obsidian-failure-detail {
		margin: 3px 0 0 22px;
		padding: 0;
	}

	.obsidian-failure-detail :global(p) {
		margin: 0;
	}

	.obsidian-failure-close {
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

	.obsidian-failure-close:hover,
	.obsidian-failure-close:focus-visible,
	.obsidian-failure-close:active {
		box-shadow: none;
		text-shadow: none;
		filter: none;
	}
</style>
