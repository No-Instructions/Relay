<script lang="ts">
	import Toast from "./Toast.svelte";
	import { toastStore, hideToast } from "../utils/toastStore";

	$: visibleToasts = Object.entries($toastStore).filter(
		([_, toast]) => toast.visible,
	);
</script>

<!-- Fixed toast container at document level -->
<div class="toast-container">
	{#each visibleToasts as [key, toast] (key)}
		<Toast
			message={toast.message}
			details={toast.details}
			type={toast.type}
			autoDismiss={toast.autoDismiss}
			source={toast.source}
			on:dismiss={() => hideToast(key)}
		/>
	{/each}
</div>

<style>
	.toast-container {
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 0;
		pointer-events: none;
		z-index: 1000;
	}
</style>
