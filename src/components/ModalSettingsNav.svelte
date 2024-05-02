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

<div class="modal-setting-nav-bar">
	<div
		class="clickable-icon"
		aria-label="Back"
		tabindex="0"
		on:click={handleGoBack}
		on:keypress={handleKeypress}
		role="button"
	>
		<ChevronLeft />
	</div>
</div>
