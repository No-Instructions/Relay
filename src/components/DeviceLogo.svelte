<script lang="ts">
	import { Phone, Laptop, Tablet } from "lucide-svelte";
	import { type Device } from "../device";
	export let device: Device;
</script>

<span style="display: flex; align-items: center;">
	{#if device.is_pc}
		<Laptop class="svg-icon" style="margin-right: .2em; flex-shrink: 0;" />
	{:else if device.is_mobile}
		<Phone class="svg-icon" style="margin-right: .2em; flex-shrink: 0;" />
	{:else if device.is_tablet}
		<Tablet class="svg-icon" style="margin-right: .2em; flex-shrink: 0;" />
	{/if}
	<slot></slot>
</span>
