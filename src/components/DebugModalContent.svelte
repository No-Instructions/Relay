<script lang="ts">
	import { writable } from "svelte/store";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import ObjectState from "./ObjectState.svelte";
	import { debounce } from "obsidian";
	import type Live from "../main";

	export let plugin: Live;

	let responseImpl = writable<string>(getResponse());
	let fetchImpl = writable<string>(getFetch());
	let usingBlink = writable<string>(getUsingBlink());
	let anyPb = writable<any>(plugin.loginManager.pb as any);

	function getResponse() {
		try {
			return Response.toString();
		} catch (e) {
			return "undefined";
		}
	}

	function getFetch() {
		try {
			return fetch.toString();
		} catch (e) {
			return "undefined";
		}
	}

	function getUsingBlink() {
		try {
			return (globalThis as any)?.blinkfetch !== undefined ? "Yes" : "No";
		} catch (e) {
			return "No";
		}
	}

	function refresh() {
		responseImpl.set(getResponse());
		fetchImpl.set(getFetch());
		usingBlink.set(getUsingBlink());
		anyPb.set(plugin.loginManager.pb as any);
	}
</script>

<div class="modal-title">Debug Information</div>

<div class="modal-content">
	<SettingItemHeading name="Environment">
		<button
			on:click={debounce(() => {
				refresh();
			})}>Refresh</button
		>
	</SettingItemHeading>

	<SettingItem name="User Agent" description="">
		{navigator.userAgent}
	</SettingItem>

	<SettingItem name="Fetch" description="">
		{$fetchImpl}
	</SettingItem>

	<SettingItem name="Response" description="">
		{$responseImpl}
	</SettingItem>

	<SettingItem name="Blink Fetch" description="">
		{$usingBlink}
	</SettingItem>

	<SettingItemHeading name="Connections" />
	<ObjectState object={$anyPb.cancelControllers} />
</div>
