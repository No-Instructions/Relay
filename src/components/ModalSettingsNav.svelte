<script lang="ts">
	import { ChevronLeft } from "lucide-svelte";
	import { createEventDispatcher } from "svelte";

	const dispatch = createEventDispatcher();

	function handleGoBack() {
		dispatch("goBack", {});
	}
	function handleKeypress(event: KeyboardEvent) {
		// XXX this seems broken
		if (event.key === "Escape") {
			dispatch("goBack", {});
			event.stopPropagation();
		}
	}
</script>

<div class="modal-setting-nav-bar relay-settings-nav-bar">
	<div
		class="clickable-icon relay-settings-back-button"
		aria-label="Back"
		tabindex="0"
		on:click={handleGoBack}
		on:keypress={handleKeypress}
		role="button"
	>
		<ChevronLeft />
	</div>
</div>

<style>
	.relay-settings-nav-bar {
		display: flex;
		align-items: center;
	}

	.relay-settings-back-button {
		flex: 0 0 auto;
	}

	/* Keep Obsidian's close control above the full-width navigation row. */
	:global(
		.modal.mod-settings:has(.relay-settings-nav-bar) > .modal-header-button
	) {
		z-index: 1;
	}
</style>
