<script lang="ts">
	import { Satellite } from "lucide-svelte";
	export let center: boolean = false;
</script>

<span style="display: inline-flex; {center ? 'align-items: center' : ''}">
	<Satellite class="svg-icon" style="margin-right: .2em; width: 1em;" />
	<slot></slot>
</span>
