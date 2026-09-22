<script lang="ts">
	import SidebarNotice from "./SidebarNotice.svelte";

	export let active: boolean;
	export let title: string;
	export let dismissLabel: string;
	export let className = "";
	export let slotClass: string;
	let dismissed = false;
	$: if (!active) dismissed = false;
</script>

{#if active && !dismissed}
	<SidebarNotice
		{title}
		{dismissLabel}
		className="{className} obsidian-failure-notice"
		{slotClass}
		warning
		onDismiss={() => { dismissed = true; }}
	>
		<slot />
	</SidebarNotice>
{/if}
