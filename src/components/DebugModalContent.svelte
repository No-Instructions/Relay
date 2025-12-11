<script lang="ts">
	import { writable } from "svelte/store";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import { debounce, requestUrl } from "obsidian";
	import type Live from "../main";
	import { getAllLogFiles, getAllLogs } from "src/debug";
	import { Bug } from "lucide-svelte";

	export let plugin: Live;

	let responseImpl = writable<string>(getResponse());
	let fetchImpl = writable<string>(getFetch());
	let usingBlink = writable<string>(getUsingBlink());
	let anyPb = writable<any>(plugin.loginManager.pb as any);
	let logFiles = writable<string[]>([]);

	getAllLogFiles().then((files) => {
		logFiles.set(files);
	});

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

<div class="modal-title">Debug Info</div>
<div class="modal-content">
	<SettingItemHeading name="Environment">
		<button
			on:click={debounce(() => {
				refresh();
			})}>Refresh</button
		>
	</SettingItemHeading>

	<SettingGroup>
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

		<SettingItem name="Startup Time" description="">
			{plugin.loadTime ? `${plugin.loadTime}ms` : "unknown"}
		</SettingItem>
	</SettingGroup>

	<SettingItemHeading name="Connections" />
	<SettingGroup>
		<SettingItem name="" description="">
			<div slot="description">
				{#each Object.keys($anyPb.cancelControllers) as connection}
					<div>
						{`${connection}`}
					</div>
				{/each}
			</div>
		</SettingItem>
	</SettingGroup>

	<SettingItemHeading name="Log Files" />
	<SettingGroup>
		<SettingItem name="" description="">
			<div slot="description">
				{#each $logFiles as lfile}
					<div>
						{`${lfile}`}
					</div>
				{/each}
			</div>
		</SettingItem>
	</SettingGroup>
</div>
