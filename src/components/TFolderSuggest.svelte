<script lang="ts">
	import { onMount, onDestroy, createEventDispatcher, tick } from "svelte";
	import { App, TFolder } from "obsidian";

	// Portal action to render content at body level
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			},
		};
	}

	// Action to position the element once it's in the portal
	function positionWhenReady(node: HTMLElement) {
		// Wait for the element to be moved to body by the portal action
		setTimeout(() => {
			suggestEl = node;
			positionSuggest();
		}, 0);

		return {
			destroy() {},
		};
	}

	export let app: App;
	export let value: string = "";
	export let placeholder: string = "Choose or create folder...";
	export let blockedPaths: Set<string> = new Set();

	const dispatch = createEventDispatcher();

	let inputEl: HTMLInputElement;
	let suggestEl: HTMLDivElement;
	let suggestions: string[] = [];
	let selectedIndex = -1;
	let isOpen = false;
	let inputValue = value || "/";
	let hasUserInput = false;

	function getSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		const folders: string[] = [];

		const getAllFoldersRecursively = (folder: TFolder) => {
			if (blockedPaths.has(folder.path) && folder.path !== "/") {
				return;
			}
			// If query is empty, show all folders; otherwise filter by query
			const folderPathLower = folder.path.toLowerCase();
			const folderPathWithSlash = (
				folder.path.startsWith("/") ? folder.path : "/" + folder.path
			).toLowerCase();

			// Match against both the original path and the path with slash prefix
			const matches =
				!lowerQuery ||
				folderPathLower.includes(lowerQuery) ||
				folderPathWithSlash.includes(lowerQuery);

			if (matches) {
				if (!blockedPaths.has(folder.path)) {
					// Ensure folder path starts with slash
					const folderPath = folder.path.startsWith("/")
						? folder.path
						: "/" + folder.path;
					folders.push(folderPath);
				}
			}
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					getAllFoldersRecursively(child);
				}
			}
		};

		const rootFolder = app.vault.getRoot();
		getAllFoldersRecursively(rootFolder);

		// Add create option if input doesn't match exactly
		const trimmed = query.trim();
		if (trimmed && !folders.includes(trimmed)) {
			// Ensure create option starts with slash too
			const createPath = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
			folders.unshift(`[Create] ${createPath}`);
		}

		// Limit to 100 suggestions
		return folders.slice(0, 100);
	}

	async function showSuggestions() {
		suggestions = getSuggestions(inputValue);
		if (suggestions.length > 0) {
			isOpen = true;
			selectedIndex = 0; // Select first suggestion by default
			await tick(); // Wait for Svelte to render
			// Positioning will be handled by the positionWhenReady action
		} else {
			closeSuggestions();
		}
	}

	function closeSuggestions() {
		isOpen = false;
		suggestions = [];
		selectedIndex = -1;
	}

	function positionSuggest() {
		if (!inputEl || !suggestEl) {
			return;
		}

		const rect = inputEl.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// Force fixed positioning with high z-index to break out of modal
		suggestEl.style.position = "fixed";
		suggestEl.style.zIndex = "9999";

		const isMobile = viewportWidth < 768;

		// Calculate height based on number of suggestions
		const suggestionHeight = 40; // Approximate height per suggestion item (increased for padding)
		const containerPadding = 8; // Container padding
		const actualHeight = Math.min(
			suggestions.length * suggestionHeight + containerPadding,
			isMobile ? 240 : 300,
		);

		// Clear any existing positioning
		suggestEl.style.top = "";
		suggestEl.style.bottom = "";
		suggestEl.style.left = "";
		suggestEl.style.right = "";
		suggestEl.style.transform = "";

		if (isMobile) {
			// Mobile: full width with padding, position from bottom like Obsidian
			const spaceBelow = viewportHeight - rect.bottom;
			const spaceAbove = rect.top;

			suggestEl.style.left = "10px";
			suggestEl.style.right = "10px";
			suggestEl.style.width = "auto";

			if (spaceBelow < actualHeight + 10 && spaceAbove > actualHeight + 10) {
				// Show above input - use bottom positioning
				suggestEl.style.bottom = `${viewportHeight - rect.top + 2}px`;
				suggestEl.style.maxHeight = `${actualHeight}px`;
				suggestEl.style.height = ""; // Let content determine height
			} else {
				// Show below input - use bottom positioning
				suggestEl.style.bottom = `${viewportHeight - rect.bottom - 2}px`;
				suggestEl.style.maxHeight = `${Math.min(actualHeight, spaceBelow - 10)}px`;
				suggestEl.style.height = ""; // Let content determine height
				suggestEl.style.transform = "translateY(-100%)"; // Position above the bottom point
			}
		} else {
			// Desktop: positioned relative to input using simple left/top
			const desktopWidth = Math.max(rect.width, 350); // Minimum 350px width for better folder path display
			const maxWidth = Math.min(desktopWidth, viewportWidth - rect.left - 20); // Don't go off screen

			suggestEl.style.left = `${rect.left}px`;
			suggestEl.style.top = `${rect.bottom + 2}px`;
			suggestEl.style.width = `${maxWidth}px`;
			suggestEl.style.maxHeight = `${actualHeight}px`;
			suggestEl.style.height = ""; // Let content determine height
		}
	}

	function selectSuggestion(suggestion: string) {
		let finalValue = suggestion;

		// Handle create option
		if (suggestion.startsWith("[Create] ")) {
			finalValue = suggestion.substring(9);
		}

		inputValue = finalValue;
		value = finalValue;
		dispatch("select", { value: finalValue });
		closeSuggestions();
		inputEl?.blur();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!isOpen) {
			if (e.key === "Enter" && inputValue.trim()) {
				e.preventDefault();
				selectSuggestion(inputValue.trim());
			} else if (e.key === "Tab" && !e.shiftKey && inputValue.trim()) {
				e.preventDefault();
				selectSuggestion(inputValue.trim());
			}
			return;
		}

		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				selectedIndex = Math.max(selectedIndex - 1, -1);
				break;
			case "Enter":
				e.preventDefault();
				if (selectedIndex >= 0) {
					selectSuggestion(suggestions[selectedIndex]);
				} else if (inputValue.trim()) {
					selectSuggestion(inputValue.trim());
				}
				break;
			case "Escape":
				e.preventDefault();
				closeSuggestions();
				break;
			case "Tab":
				if (!e.shiftKey) {
					e.preventDefault();
					if (selectedIndex >= 0) {
						selectSuggestion(suggestions[selectedIndex]);
					} else if (suggestions.length > 0) {
						selectSuggestion(suggestions[0]);
					} else if (inputValue.trim()) {
						selectSuggestion(inputValue.trim());
					}
				}
				break;
		}
	}

	function handleInput() {
		hasUserInput = true;
		// Update the exported value prop
		value = inputValue;
		dispatch("input", { value: inputValue });
		showSuggestions();
	}

	function handleFocus() {
		// Show all suggestions on focus, even with empty input
		// Clear default "/" value on first focus
		if (!hasUserInput && inputValue === "/") {
			inputValue = "";
			value = "";
		}

		suggestions = getSuggestions(inputValue || "");
		if (suggestions.length > 0) {
			isOpen = true;
			selectedIndex = 0; // Select first suggestion by default
			// Don't call positionSuggest here - it will be handled by the action
		}
	}

	function handleBlur(e: FocusEvent) {
		// Delay close to allow click events on suggestions
		setTimeout(() => {
			if (!suggestEl?.contains(document.activeElement)) {
				closeSuggestions();
			}
		}, 200);
	}

	function handleSuggestionClick(suggestion: string) {
		selectSuggestion(suggestion);
	}

	function handleDocumentClick(e: MouseEvent) {
		if (
			!inputEl?.contains(e.target as Node) &&
			!suggestEl?.contains(e.target as Node)
		) {
			closeSuggestions();
		}
	}

	function handleWindowResize() {
		if (isOpen) {
			positionSuggest();
		}
	}

	onMount(() => {
		document.addEventListener("click", handleDocumentClick);
		window.addEventListener("resize", handleWindowResize);
	});

	onDestroy(() => {
		document.removeEventListener("click", handleDocumentClick);
		window.removeEventListener("resize", handleWindowResize);
	});
</script>

<div class="folder-suggest-wrapper">
	<input
		bind:this={inputEl}
		bind:value={inputValue}
		on:input={handleInput}
		on:keydown={handleKeydown}
		on:focus={handleFocus}
		on:blur={handleBlur}
		type="text"
		{placeholder}
		class="folder-suggest-input"
	/>
</div>

{#if isOpen && suggestions.length > 0}
	<div class="suggestion-container" use:portal use:positionWhenReady>
		<div class="suggestion">
			{#each suggestions as suggestion, i}
				<div
					class="suggestion-item mod-complex"
					class:is-selected={i === selectedIndex}
					role="option"
					aria-selected={i === selectedIndex}
					tabindex="-1"
					on:mousedown|preventDefault
					on:click={() => handleSuggestionClick(suggestion)}
					on:keydown={(e) =>
						e.key === "Enter" && handleSuggestionClick(suggestion)}
					on:mouseenter={() => (selectedIndex = i)}
				>
					<div class="suggestion-content">
						<div class="suggestion-title">
							{#if suggestion.startsWith("[Create] ")}
								<span class="suggestion-note"
									>Create:
								</span>{suggestion.substring(9)}
							{:else}
								{suggestion}
							{/if}
						</div>
					</div>
					<div class="suggestion-aux">
						<div class="suggestion-icon"></div>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.folder-suggest-wrapper {
		position: relative;
		width: 100%;
	}

	.folder-suggest-input {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		background: var(--background-primary);
		color: var(--text-normal);
	}

	.suggestion-container {
		position: fixed;
		z-index: 9999;
		box-sizing: border-box;
		background: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		box-shadow: var(--shadow-s);
		overflow-y: auto;
		overflow-x: hidden;
	}

	.suggestion {
		overflow-y: auto;
		overflow-x: hidden;
		max-height: 100%;
	}

	.suggestion-note {
		color: var(--text-muted);
		font-style: italic;
	}
</style>
