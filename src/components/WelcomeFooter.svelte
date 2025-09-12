<script lang="ts">
	import Discord from "./Discord.svelte";
	import { Platform } from "obsidian";

	const helpText =
		"We require sign-in because your vault needs to communicate securely with Relay servers for syncing. Using an identity provider helps to prevent spam accounts and ensures secure authentication.";

	let isVisible = false;
	let isMobile = false;
	let buttonEl: HTMLButtonElement;
	let popoverEl: HTMLDivElement;

	$: {
		isMobile = Platform?.isMobile ?? false;
	}

	function handleMouseEnter() {
		if (!isMobile) {
			isVisible = true;
		}
	}

	function handleMouseLeave() {
		if (!isMobile) {
			isVisible = false;
		}
	}

	function handleClick() {
		if (isMobile) {
			isVisible = !isVisible;
		}
	}
</script>

<!-- Help section -->
<div class="help-section">
	<div class="help-container">
		<button
			class="why-signin"
			class:mobile={isMobile}
			bind:this={buttonEl}
			on:mouseenter={handleMouseEnter}
			on:mouseleave={handleMouseLeave}
			on:click={handleClick}
		>
			Why do I need to sign in?
		</button>

		{#if isMobile}
			{#if isVisible}
				<div class="help-content">
					<p>{helpText}</p>
				</div>
			{/if}
		{:else}
			<div bind:this={popoverEl} class="popover" class:visible={isVisible}>
				<div class="arrow" />
				<p>{helpText}</p>
			</div>
		{/if}
	</div>
</div>

<!-- Discord link -->
<div class="footer">
	<a href="https://discord.system3.md" class="discord-link">
		<Discord />
		Join the project on Discord
	</a>
</div>

<style>
	.help-section {
		width: 100%;
		padding: 0 2rem;
		margin-bottom: 2rem;
	}
	.footer {
		padding: 0 2rem;
		margin-bottom: 2rem;
		text-align: center;
	}
	.help-container {
		position: relative;
		max-width: 640px;
		margin: 0 auto;
	}
	.why-signin:hover {
		background-color: transparent !important;
		box-shadow: none;
		color: var(--text-modifier-hover);
	}
	.why-signin {
		outline: 0;
		color: var(--text-muted);
		font-size: 0.875rem;
		margin: 0;
		background-color: transparent !important;
		box-shadow: none;
		text-decoration-line: var(--link-decoration);
		padding: 0;
		border: none;
		cursor: pointer;
		width: 100%;
		text-align: left;
	}
	.why-signin:hover {
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
		text-align: left;
	}
	.popover {
		position: absolute;
		z-index: 50;
		width: 256px;
		padding-left: 1em;
		padding-right: 1em;
		font-size: 0.875rem;
		background-color: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		box-shadow: var(--shadow-s);
		top: calc(100% + 8px);
		text-align: left;
		left: 50%;
		transform: translateX(-50%);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity 0.3s ease,
			visibility 0.3s ease;
		transition-delay: 0.1s;
	}
	.popover.visible {
		opacity: 1;
		visibility: visible;
	}
	.popover:not(.visible) {
		transition-delay: 0s;
	}
	.arrow {
		position: absolute;
		width: 8px;
		height: 8px;
		background-color: var(--background-primary);
		border-top: 1px solid var(--background-modifier-border);
		border-left: 1px solid var(--background-modifier-border);
		transform: rotate(45deg);
		top: -5px;
		right: 40px;
	}
	.discord-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		color: var(--text-muted);
		font-size: 0.875rem;
		margin: 0;
	}
</style>
