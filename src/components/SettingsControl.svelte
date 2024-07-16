<script>
	import { Settings } from "lucide-svelte";
	import { createEventDispatcher } from "svelte";

	const dispatch = createEventDispatcher();

	function handleSettingsClick() {
		dispatch("settings");
	}
</script>

<div
	class="clickable-icon extra-setting-button"
	aria-label="Options"
	role="button"
	tabindex="0"
	on:click={handleSettingsClick}
	on:keydown={handleSettingsClick}
>
	<Settings
		class="svg-icon lucide-settings"
		props={{ class: "svg-icon lucide-settings" }}
	/>
</div>
