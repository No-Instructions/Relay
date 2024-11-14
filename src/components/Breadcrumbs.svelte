<script lang="ts">
	import { ChevronRight } from "lucide-svelte";
	import { createEventDispatcher } from "svelte";
	import Satellite from "./Satellite.svelte";
	import Folder from "./Folder.svelte";

	export let category: typeof Satellite | typeof Folder;
	export let categoryText: string;

	const dispatch = createEventDispatcher<{
		goBack: void;
	}>();

	function handleGoBack() {
		dispatch("goBack");
	}
</script>

<h4>
	<svelte:component this={category}>
		<span
			on:click={handleGoBack}
			on:keypress={handleGoBack}
			tabindex="0"
			role="button"
		>
			{categoryText}
		</span>

		<ChevronRight size={16} />

		<span
			style="flex: 1; min-width: 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;"
		>
			<slot />
		</span>
	</svelte:component>
</h4>
