<script lang="ts">
	import { AlertTriangle, Info, X } from "lucide-svelte";

	export let title: string;
	export let dismissLabel: string;
	export let className = "";
	export let slotClass: string;
	export let warning = false;
	export let onDismiss: () => void;
</script>

<div class="system3-sidebar-notice-slot {slotClass}">
	<div class="{className} sidebar-notice callout" data-callout={warning ? "warning" : "info"} role="status">
		<div class="callout-title sidebar-notice-title-row">
			<div class="callout-icon">
				{#if warning}<AlertTriangle size={14} />{:else}<Info size={14} />{/if}
			</div>
			<div class="callout-title-inner">{title}</div>
			<button
				class="clickable-icon sidebar-notice-close"
				type="button"
				aria-label={dismissLabel}
				on:click={onDismiss}
			>
				<X size={14} />
			</button>
		</div>
		<div class="callout-content sidebar-notice-detail">
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

	.sidebar-notice-title-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 0;
	}

	.sidebar-notice-title-row .callout-icon {
		margin-top: 1px;
	}

	.sidebar-notice-title-row .callout-title-inner {
		flex: 1 1 auto;
		min-width: 0;
	}

	.sidebar-notice-detail {
		margin: 3px 0 0 22px;
		padding: 0;
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
