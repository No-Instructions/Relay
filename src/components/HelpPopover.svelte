<script lang="ts">
	import { HelpCircle } from "lucide-svelte";
	export let helpText: string;

	let isVisible = false;
	let position: "left" | "right" = "right";
	let buttonEl: HTMLButtonElement;
	let popoverEl: HTMLDivElement;

	$: if (isVisible && buttonEl && popoverEl) {
		const buttonRect = buttonEl.getBoundingClientRect();
		const popoverRect = popoverEl.getBoundingClientRect();
		const windowWidth = window.innerWidth;

		position =
			buttonRect.right + popoverRect.width > windowWidth - 20
				? "left"
				: "right";
	}

	function handleMouseEnter() {
		isVisible = true;
	}

	function handleMouseLeave() {
		isVisible = false;
	}

	function handleClick() {
		isVisible = !isVisible;
	}
</script>

<div class="help-container">
	<button
		bind:this={buttonEl}
		on:mouseenter={handleMouseEnter}
		on:mouseleave={handleMouseLeave}
		on:click={handleClick}
		type="button"
	>
		<HelpCircle size={16} />
	</button>

	{#if isVisible}
		<div
			bind:this={popoverEl}
			class="popover"
			class:left={position === "left"}
			class:right={position === "right"}
		>
			<div
				class="arrow"
				class:left={position === "left"}
				class:right={position === "right"}
			/>
			<p>{helpText}</p>
		</div>
	{/if}
</div>

<style>
	.help-container {
		position: relative;
		display: inline-block;
	}

	button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 2px;
		margin: 0;
		background: transparent;
		border: none;
		color: var(--text-muted);
		border-radius: 50%;
	}

	button:hover {
		box-shadow: none;
		color: var(--text-normal);
		background: transparent;
		border-radius: 0;
	}

	.popover {
		position: absolute;
		z-index: 50;
		width: 256px;
		padding: 8px;
		font-size: 0.875rem;
		background-color: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		box-shadow: var(--shadow-s);
		top: 32px;
	}

	.popover.left {
		right: 100%;
		margin-right: 8px;
	}

	.popover.right {
		left: 0;
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
	}

	.arrow.left {
		right: 8px;
	}

	.arrow.right {
		left: 8px;
	}

	p {
		margin: 0;
		color: var(--text-normal);
	}
</style>
