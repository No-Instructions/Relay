<script lang="ts">
	import { onMount, createEventDispatcher } from "svelte";

	export let placeholder: string = "Search...";
	export let autofocus: boolean = false;
	export let onSelect: (item: any) => void = () => {};
	export let getSuggestions: (query: string) => any[] = () => [];
	export let instructions: Array<{ command: string; purpose: string }> = [
		{ command: "↑/↓", purpose: "Navigate" },
		{ command: "Enter", purpose: "Select" },
		{ command: "Esc", purpose: "Cancel" },
	];

	const dispatch = createEventDispatcher();

	let inputEl: HTMLInputElement;
	let suggestions: any[] = [];
	let selectedIndex = 0;
	let inputValue = "";

	function updateSuggestions() {
		suggestions = getSuggestions(inputValue);
		selectedIndex = 0;
	}

	function selectSuggestion(item: any) {
		onSelect(item);
		dispatch("select", { item });
	}

	function handleKeydown(e: KeyboardEvent) {
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
				} else if (inputValue.trim() && suggestions.length === 0) {
					// Allow custom input if no suggestions
					dispatch("customInput", { value: inputValue.trim() });
				}
				break;
			case "Tab":
				if (!e.shiftKey) {
					e.preventDefault();
					if (selectedIndex >= 0) {
						selectSuggestion(suggestions[selectedIndex]);
					} else if (suggestions.length > 0) {
						selectSuggestion(suggestions[0]);
					}
				}
				break;
		}
	}

	function handleInput() {
		updateSuggestions();
		dispatch("input", { value: inputValue });
	}

	function handleSuggestionClick(item: any) {
		selectSuggestion(item);
	}

	onMount(() => {
		if (autofocus && inputEl) {
			setTimeout(() => {
				inputEl.focus();
			}, 10);
		}
		// Initialize suggestions
		updateSuggestions();
	});
</script>

<div class="prompt">
	<div class="prompt-input-container">
		<input
			bind:this={inputEl}
			bind:value={inputValue}
			on:input={handleInput}
			on:keydown={handleKeydown}
			type="text"
			{placeholder}
			class="prompt-input"
			autocapitalize="off"
			spellcheck="false"
			enterkeyhint="done"
		/>
		<div class="prompt-input-cta"></div>
		<div class="search-input-clear-button"></div>
	</div>

	<div class="prompt-results">
		{#each suggestions as item, i}
			<div
				class="suggestion-item mod-complex"
				class:is-selected={i === selectedIndex}
				role="option"
				aria-selected={i === selectedIndex}
				tabindex="-1"
				on:mousedown|preventDefault
				on:click={() => handleSuggestionClick(item)}
				on:keydown={(e) => e.key === "Enter" && handleSuggestionClick(item)}
				on:mouseenter={() => (selectedIndex = i)}
			>
				<div class="suggestion-content">
					<div class="suggestion-title">
						<slot name="suggestion" {item} index={i}>
							{item}
						</slot>
					</div>
				</div>
				<div class="suggestion-aux">
					<slot name="suggestion-aux" {item} index={i}>
						<div class="suggestion-icon"></div>
					</slot>
				</div>
			</div>
		{/each}
	</div>

	<div class="prompt-instructions">
		{#each instructions as instruction}
			<div class="prompt-instruction">
				<span class="prompt-instruction-command">{instruction.command}</span>
				<span>{instruction.purpose}</span>
			</div>
		{/each}
	</div>
</div>
