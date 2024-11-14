<script lang="ts">
	import { Satellite } from "lucide-svelte";
	import { type Relay } from "src/Relay";
	import { createEventDispatcher } from "svelte";
	export let relay: Relay | undefined = undefined;

	const dispatch = createEventDispatcher();
	function manageRelay(): void {
		if (relay) {
			dispatch("manageRelay", { relay });
		}
	}
</script>

<span
	role="button"
	tabindex="0"
	on:keypress={manageRelay}
	on:click={manageRelay}
	style="display: inline-flex; align-items:center; "
>
	<Satellite class="svg-icon" style="margin-right: .2em;" />
	<slot></slot>
</span>
