<script lang="ts">
	import { writable } from "svelte/store";
	import { Notice, debounce, setIcon } from "obsidian";
	import { createEventDispatcher } from "svelte";

	// Event dispatcher
	const dispatch = createEventDispatcher();

	// Props
	export let value: string;
	export let disabled: boolean = false;
	export let placeholder: string = "please wait...";
	export let readonly: boolean = true;
	export let copyOnClick: boolean = true;
	export let successMessage: string = "Copied to clipboard";
	export let invalid: boolean = false;

	// Internal state
	let showSecret = writable(false);
	let showClipboardIcon = writable(false);
	let toggleIcon: HTMLElement;

	// Handle key press events
	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === "Enter" && !disabled) {
			dispatch("enter");
		}
	}

	// Toggle icon handler
	function setToggleIcon(node: HTMLElement) {
		toggleIcon = node;

		const updateIcon = () => {
			if ($showClipboardIcon) {
				setIcon(node, "clipboard-check");
				node.addClass("mod-success");
			} else {
				setIcon(node, $showSecret ? "eye-off" : "eye");
				node.removeClass("mod-success");
			}
		};

		const unsubscribeShowSecret = showSecret.subscribe(() => {
			updateIcon();
		});

		const unsubscribeClipboard = showClipboardIcon.subscribe(() => {
			updateIcon();
		});

		updateIcon();

		return {
			destroy() {
				unsubscribeShowSecret();
				unsubscribeClipboard();
			},
		};
	}

	// Copy value handler
	function copyValue(event: Event) {
		if (!copyOnClick || !value || disabled) return;

		navigator.clipboard
			.writeText(value)
			.then(() => {
				new Notice(successMessage);
				showClipboardIcon.set(true);
				setTimeout(() => {
					showClipboardIcon.set(false);
				}, 800);
			})
			.catch((err) => {
				console.error("Failed to copy: ", err);
			});
	}
</script>

<div class="input-with-icon">
	{#if $showSecret}
		<input
			{value}
			{placeholder}
			type="text"
			{readonly}
			on:click={copyOnClick ? debounce(copyValue) : null}
			on:input={(e) => {
				value = e.currentTarget.value;
				dispatch("input", e);
			}}
			on:keydown={handleKeyDown}
			class={`system3-secret-text ${invalid ? "system3-input-invalid" : ""}`}
			{disabled}
		/>
	{:else}
		<input
			{value}
			{placeholder}
			type="password"
			{readonly}
			on:click={copyOnClick ? debounce(copyValue) : null}
			on:input={(e) => {
				value = e.currentTarget.value;
				dispatch("input", e);
			}}
			on:keydown={handleKeyDown}
			class={`system3-secret-text ${invalid ? "system3-input-invalid" : ""}`}
			{disabled}
		/>
	{/if}
	<div
		class="secret-text-toggle-icon"
		role="button"
		tabindex="0"
		use:setToggleIcon
		on:click={() => showSecret.update((v) => !v)}
		on:keypress={() => showSecret.update((v) => !v)}
		aria-label={$showSecret ? "Hide text" : "Show text"}
	></div>
</div>

<style>
	.input-with-icon {
		position: relative;
		width: 100%;
	}

	.secret-text-toggle-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		width: 24px;
		height: 24px;
		position: absolute;
		right: 12px;
		top: 50%;
		transform: translateY(-50%);
		border-radius: 4px;
	}

	.secret-text-toggle-icon:hover {
		background-color: var(--background-modifier-hover);
	}

	.system3-secret-text {
		padding-inline-end: 28px !important;
		font-family: monospace !important;
	}

	.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}
</style>
