<script lang="ts">
	export let toml: string = "";

	let copied = false;

	// Convert base64url to base64
	function formatKey(key: string): string {
		// Convert base64url to base64
		let base64Key = key.replace(/-/g, "+").replace(/_/g, "/");

		// Add padding if needed
		const padding = base64Key.length % 4;
		if (padding) {
			base64Key += "=".repeat(4 - padding);
		}

		return base64Key;
	}

	// TOML tokenizer for syntax highlighting
	function tokenizeToml(text: string) {
		const tokens: Array<{ type: string; value: string }> = [];
		const lines = text.split("\n");

		for (const line of lines) {
			const trimmed = line.trim();

			if (trimmed === "") {
				tokens.push({ type: "newline", value: line });
			} else if (trimmed.startsWith("#")) {
				tokens.push({ type: "comment", value: line });
			} else if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
				// Array of tables: [[auth]]
				const match = line.match(/^(\s*)\[\[([^\]]+)\]\](\s*)$/);
				if (match) {
					const [, leading, tableName, trailing] = match;
					tokens.push({
						type: "array-table",
						value: line,
						parts: { leading, tableName, trailing },
					});
				} else {
					tokens.push({ type: "text", value: line });
				}
			} else if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
				// Regular table: [server]
				const match = line.match(/^(\s*)\[([^\]]+)\](\s*)$/);
				if (match) {
					const [, leading, tableName, trailing] = match;
					tokens.push({
						type: "table",
						value: line,
						parts: { leading, tableName, trailing },
					});
				} else {
					tokens.push({ type: "text", value: line });
				}
			} else if (trimmed.includes("=")) {
				// Key-value pair: key = "value"
				const match = line.match(/^(\s*)([^=]+?)\s*=\s*(.+)(\s*)$/);
				if (match) {
					const [, leading, key, value, trailing] = match;
					tokens.push({
						type: "key-value",
						value: line,
						parts: { leading, key: key.trim(), value: value.trim(), trailing },
					});
				} else {
					tokens.push({ type: "text", value: line });
				}
			} else {
				tokens.push({ type: "text", value: line });
			}
		}

		return tokens;
	}

	// Render tokens as HTML spans
	function renderTokens(
		tokens: Array<{ type: string; value: string; parts?: any }>,
	) {
		return tokens
			.map((token) => {
				switch (token.type) {
					case "comment":
						return `<span class="token comment">${token.value}</span>`;
					case "newline":
						return token.value;
					case "table":
						const {
							leading: tLeading,
							tableName,
							trailing: tTrailing,
						} = token.parts;
						return `${tLeading}<span class="token punctuation">[</span><span class="token table class-name">${tableName}</span><span class="token punctuation">]</span>${tTrailing}`;
					case "array-table":
						const {
							leading: aLeading,
							tableName: aTableName,
							trailing: aTrailing,
						} = token.parts;
						return `${aLeading}<span class="token punctuation">[[</span><span class="token table class-name">${aTableName}</span><span class="token punctuation">]]</span>${aTrailing}`;
					case "key-value":
						const {
							leading: kvLeading,
							key,
							value,
							trailing: kvTrailing,
						} = token.parts;
						let renderedValue = value;
						if (value.startsWith('"') && value.endsWith('"')) {
							renderedValue = `<span class="token string">${value}</span>`;
						} else if (/^\d+$/.test(value)) {
							renderedValue = `<span class="token number">${value}</span>`;
						} else {
							renderedValue = `<span class="token string">${value}</span>`;
						}
						return `${kvLeading}<span class="token key property">${key}</span> <span class="token punctuation">=</span> ${renderedValue}${kvTrailing}`;
					default:
						return token.value;
				}
			})
			.join("\n");
	}

	// Generate syntax highlighted HTML
	$: highlightedHtml = toml ? renderTokens(tokenizeToml(toml)) : "";

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(toml);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (err) {
			console.error("Failed to copy text: ", err);
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter") {
			event.preventDefault();
			copyToClipboard();
		}
	}
</script>

{#if toml}
	<div class="el-pre">
		<pre class="language-toml"><code class="language-toml is-loaded"
				>{@html highlightedHtml}</code
			><button
				class="copy-code-button"
				aria-label={copied ? "Copied to clipboard" : "Copy"}
				on:click={copyToClipboard}
				on:keydown={handleKeydown}>
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
						class="svg-icon lucide-check">
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
						class="svg-icon lucide-copy">
						<rect x="8" y="8" width="14" height="14" rx="2" ry="2"></rect>
						<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
					</svg>
				{/if}
			</button></pre>
	</div>
{:else}
	<div class="error-message">No configuration available</div>
{/if}

<style>
	.el-pre {
		position: relative;
		margin: 1em 0;
	}

	pre.language-toml {
		position: relative;
		background: var(--code-background);
		border-radius: var(--radius-s);
		padding: 1em;
		overflow-x: auto;
		font-family: var(--font-monospace);
		font-size: var(--code-size);
		line-height: var(--line-height-normal);
		tab-size: 4;
		border: 1px solid var(--background-modifier-border);
	}

	code.language-toml {
		display: block;
		color: var(--code-normal);
		white-space: pre-wrap;
		word-wrap: break-word;
		word-break: break-all;
		font-family: inherit;
		user-select: text;
		-webkit-user-select: text;
		-moz-user-select: text;
		-ms-user-select: text;
	}

	/* Copy button */
	.copy-code-button {
		position: absolute;
		top: 0.5em;
		right: 0.5em;
		padding: 0.25em;
		background: transparent;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 0.2s ease,
			color 0.2s ease;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: none !important;
	}

	.el-pre:hover .copy-code-button {
		opacity: 0.7;
		box-shadow: none;
	}

	.copy-code-button:hover {
		opacity: 1 !important;
		color: var(--text-normal);
		background: transparent;
		border: none;
		box-shadow: none !important;
	}

	.copy-code-button:focus {
		outline: none;
		border: none;
		opacity: 1;
		color: var(--interactive-accent);
		background: transparent;
		box-shadow: none !important;
	}

	.svg-icon {
		width: 16px;
		height: 16px;
	}

	.error-message {
		background: var(--background-secondary);
		color: var(--text-error);
		border: 1px solid var(--text-error);
		border-radius: var(--radius-s);
		padding: 12px;
		margin: 16px 0;
		font-size: 0.9em;
	}
</style>
