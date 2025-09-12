<script lang="ts">
	import { createEventDispatcher } from "svelte";

	export let value: string = "";
	export let readonly: boolean = false;
	export let copyOnClick: boolean = false;
	export let successMessage: string = "Copied to clipboard";
	export let language: string = "";

	const dispatch = createEventDispatcher();

	let copied = false;

	async function copyToClipboard() {
		if (!copyOnClick || !value) return;

		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
			dispatch("copy", { value });
		} catch (err) {
			console.error("Failed to copy text: ", err);
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && copyOnClick) {
			event.preventDefault();
			copyToClipboard();
		}
	}
</script>

<div class="code-block-container">
	<div class="code-block-wrapper">
		<div
			class="HyperMD-codeblock HyperMD-codeblock-begin HyperMD-codeblock-begin-bg HyperMD-codeblock-bg cm-line"
		>
			{#if language}
				<span class="code-block-lang">{language}</span>
			{/if}
			{#if copyOnClick}
				<span
					class="code-block-flair"
					aria-label={copied ? successMessage : "Copy"}
					role="button"
					tabindex="0"
					on:click={copyToClipboard}
					on:keydown={handleKeydown}
				>
					{#if copied}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="svg-icon lucide-check"
						>
							<polyline points="20,6 9,17 4,12"></polyline>
						</svg>
					{:else}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="24"
							height="24"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="svg-icon lucide-copy"
						>
							<rect x="8" y="8" width="14" height="14" rx="2" ry="2"></rect>
							<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
							></path>
						</svg>
					{/if}
				</span>
			{/if}
		</div>
		<div class="HyperMD-codeblock HyperMD-codeblock-bg cm-line">
			{#if readonly}
				<pre class="cm-hmd-codeblock" spellcheck="false">{value}</pre>
			{:else}
				<textarea
					class="cm-hmd-codeblock cm-hmd-codeblock-textarea"
					spellcheck="false"
					bind:value
					{readonly}
					on:input
					on:change
					on:focus
					on:blur
				></textarea>
			{/if}
		</div>
		<div
			class="HyperMD-codeblock HyperMD-codeblock-bg HyperMD-codeblock-end HyperMD-codeblock-end-bg cm-line"
		></div>
	</div>
</div>

<style>
	.code-block-container {
		width: 100%;
		font-family: var(--font-monospace);
	}

	.code-block-wrapper {
		position: relative;
		background: var(--code-background);
		border-radius: var(--radius-s);
		border: 1px solid var(--background-modifier-border);
	}

	.HyperMD-codeblock {
		display: flex;
		align-items: center;
		min-height: 1.5em;
		padding: 0 12px;
		position: relative;
	}

	.HyperMD-codeblock-begin {
		justify-content: space-between;
		padding: 0 8px;
		min-height: 2em;
	}

	.code-block-lang {
		font-size: 0.75em;
		color: var(--text-muted);
		font-family: var(--font-interface);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		opacity: 0.7;
	}

	.HyperMD-codeblock-bg {
		background: var(--code-background);
	}

	.HyperMD-codeblock-begin-bg {
		border-top-left-radius: var(--radius-s);
		border-top-right-radius: var(--radius-s);
	}

	.HyperMD-codeblock-end-bg {
		border-bottom-left-radius: var(--radius-s);
		border-bottom-right-radius: var(--radius-s);
		min-height: 0.5em;
	}

	.code-block-flair {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		cursor: pointer;
		opacity: 0.6;
		transition: opacity 0.2s ease;
		color: var(--text-muted);
	}

	.code-block-flair:hover {
		opacity: 1;
		color: var(--text-normal);
	}

	.code-block-flair:focus {
		outline: none;
		opacity: 1;
		color: var(--interactive-accent);
	}

	.cm-hmd-codeblock {
		font-family: var(--font-monospace);
		font-size: 0.9em;
		color: var(--code-normal);
		background: transparent;
		border: none;
		outline: none;
		width: 100%;
		padding: 8px 0;
		line-height: 1.4;
		white-space: pre-wrap;
		word-wrap: break-word;
		margin: 0;
		user-select: text;
		-webkit-user-select: text;
		-moz-user-select: text;
		-ms-user-select: text;
	}

	.cm-hmd-codeblock-textarea {
		resize: vertical;
		min-height: 3em;
	}

	.svg-icon {
		width: 16px;
		height: 16px;
	}
</style>
