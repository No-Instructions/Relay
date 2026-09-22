<script lang="ts">
	import { AlertTriangle, X } from "lucide-svelte";
	import RelayMark from "./RelayMark.svelte";

	export let title: string;
	export let dismissLabel: string;
	export let className = "";
	export let slotClass: string;
	export let warning = false;
	export let backgroundColor: string | undefined = undefined;
	export let color: string | undefined = undefined;
	export let onDismiss: () => void;
</script>

<div class="system3-sidebar-notice-slot {slotClass}">
	<div class="{className} sidebar-notice" class:callout={warning} data-callout={warning ? "warning" : undefined} role="status" style:background-color={backgroundColor} style:color={color}>
		<div class="sidebar-notice-title-row" class:callout-title={warning}>
			<div class="sidebar-notice-icon" class:callout-icon={warning} style:color={color}>
				{#if warning}<AlertTriangle size={14} />{:else}<RelayMark />{/if}
			</div>
			<div class="sidebar-notice-title" class:callout-title-inner={warning}>{title}</div>
			<button
				class="clickable-icon sidebar-notice-close"
				type="button"
				aria-label={dismissLabel}
				on:click={onDismiss}
			>
				<X size={14} />
			</button>
		</div>
		<div class="sidebar-notice-detail" class:callout-content={warning}>
			<p><slot /></p>
		</div>
	</div>
</div>

<style>
	:global(.workspace-split) > .system3-sidebar-notice-slot {
		order: 1;
		flex: 0 0 auto;
		height: auto;
		min-height: 0;
		overflow: visible;
	}

	.sidebar-notice {
		margin: 8px;
		padding: 8px 10px;
		font-size: var(--font-ui-small);
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.sidebar-notice:not(.callout) {
		margin: 0;
		padding: var(--size-4-3);
		border-top: 1px solid var(--background-modifier-border);
		background-color: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
		font-size: var(--font-ui-medium);
		line-height: var(--line-height-normal);
		color: var(--text-normal);
	}

	.sidebar-notice:not(.callout) .sidebar-notice-title {
		font-weight: var(--font-semibold);
	}

	.sidebar-notice:not(.callout) .sidebar-notice-icon {
		color: var(--text-accent);
	}

	.sidebar-notice-title-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 0;
	}

	.sidebar-notice-icon {
		margin-top: 1px;
		display: flex;
		flex: 0 0 auto;
	}

	.sidebar-notice-title {
		flex: 1 1 auto;
		min-width: 0;
	}

	.sidebar-notice-detail {
		margin: 3px 0 0 22px;
		padding: 0;
	}

	.sidebar-notice:not(.callout) .sidebar-notice-detail {
		margin: var(--size-4-2) 0 0;
	}

	.sidebar-notice-detail :global(p) {
		margin: 0;
	}

	.sidebar-notice-close {
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

	.sidebar-notice-close:hover,
	.sidebar-notice-close:focus-visible,
	.sidebar-notice-close:active {
		box-shadow: none;
		text-shadow: none;
		filter: none;
	}
</style>
