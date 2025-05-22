<script lang="ts">
	import { User } from "../User";
	import Avatar from "./Avatar.svelte";
	import { createEventDispatcher } from "svelte";
	import { debounce } from "obsidian";
	import { Platform } from "obsidian";
	import DeviceLogo from "./DeviceLogo.svelte";
	import type { RelayUser } from "src/Relay";
	import type { Device } from "../device";
	import { writable } from "svelte/store";
	import { flags } from "src/flagManager";

	export let user: RelayUser;
	export let devices: Device[] = [];

	const expandedDeviceIndex = writable<number | null>(null);

	function toggleDeviceDetails(index: number) {
		if ($expandedDeviceIndex === index) {
			expandedDeviceIndex.set(null);
		} else {
			expandedDeviceIndex.set(index);
		}
	}
</script>

<div class="setting-item">
	<Avatar size="2.5em" {user} />
	<div class="setting-item-info">
		<div class="setting-item-description">
			{user.name || ""}
			{#if devices && devices.length > 0 && flags().enableShowDeviceInfo}
				<br />
				{#each devices as device, index}
					<button
						class="device-details-button"
						on:click={() => {
							toggleDeviceDetails(index);
						}}
					>
						<DeviceLogo {device}></DeviceLogo>
					</button>
				{/each}
			{/if}
		</div>
		<div class="setting-item-control">
			<slot></slot>
		</div>
	</div>
</div>
{#if $expandedDeviceIndex !== null}
	<div class="device-details">
		{devices[$expandedDeviceIndex].os}
		{devices[$expandedDeviceIndex].os_version} <br />
		Relay {devices[$expandedDeviceIndex].relay_version}
	</div>
{/if}

<style>
	.setting-item-info {
		display: flex !important;
	}
	.device-details {
		font-size: var(--font-ui-smaller);
	}
	.device-details-button {
		height: 20px;
		display: inline-flex;
		align-items: center;
		justify-content: space-between;
		padding: 0px 0px;
		background: transparent;
		border: none;
		text-align: left;
		color: var(--text-muted);
		box-shadow: none;
		-webkit-tap-highlight-color: transparent;
	}

	.setting-item-control {
		width: unset !important;
		margin-top: unset !important;
	}
	.setting-item {
		flex-direction: unset !important;
	}
	.setting-item-info {
		min-width: 0;
		margin-top: auto;
		margin-bottom: auto;
	}
</style>
