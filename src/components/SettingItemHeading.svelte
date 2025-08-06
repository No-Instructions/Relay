<script lang="ts">
	import { HelpCircle } from "lucide-svelte";
	import { Platform } from "obsidian";
	import HelpPopover from "./HelpPopover.svelte";
	export let name: HTMLSpanElement | string = "";
	export let helpText: string | undefined = undefined;

	let isHelpExpanded = false;
	let isMobile = false;

	$: {
		isMobile = Platform?.isMobile ?? false;
	}

	function toggleHelp() {
		if (isMobile) {
			isHelpExpanded = !isHelpExpanded;
		}
	}
</script>

<div class="setting-item setting-item-heading mod-list-item">
	<div class="setting-item-info">
		<div class="setting-item-name">
			<slot name="name">{name}</slot>
			{#if helpText}
				{#if isMobile}
					<button
						class="help-button"
						on:click={toggleHelp}
						aria-expanded={isHelpExpanded}
					>
						<HelpCircle size={16} />
					</button>
				{:else}
					<HelpPopover {helpText} />
				{/if}
			{/if}
		</div>
		<slot name="description">
			<div class="setting-item-description">
				<slot name="description"></slot>
			</div>
		</slot>
		{#if helpText && isHelpExpanded && isMobile}
			<div class="help-content" class:expanded={isHelpExpanded}>
				<p>{helpText}</p>
			</div>
		{/if}
	</div>
	<div class="setting-item-control">
		<slot></slot>
	</div>
</div>

<style>
	.setting-item-name {
		display: flex;
		align-items: center;
		gap: 8px;
		overflow: unset;
	}

	.help-button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 2px !important;
		margin: 0;
		background: transparent;
		border: none;
		color: var(--text-muted);
		border-radius: 50%;
		-webkit-tap-highlight-color: transparent;
	}

	@media (hover: hover) {
		.help-button:hover {
			box-shadow: none;
			color: var(--text-normal);
			background: transparent;
			border-radius: 0;
		}
	}

	.help-button:active {
		color: var(--text-normal);
	}

	.help-content {
		margin-top: 8px;
		padding: 12px 16px;
		background: var(--color-base-05);
		border-radius: 4px;
		font-size: 0.9em;
		color: var(--text-muted);
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	p {
		margin: 0;
	}
</style>
