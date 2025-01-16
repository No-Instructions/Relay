<script lang="ts">
	import { writable } from "svelte/store";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import { debounce, requestUrl } from "obsidian";
	import type Live from "../main";
	import { getAllLogFiles, getAllLogs } from "../debug";

	export let plugin: Live;

	let responseImpl = writable<string>(getResponse());
	let fetchImpl = writable<string>(getFetch());
	let usingBlink = writable<string>(getUsingBlink());
	let bugDescription = writable<string>("");
	let includeLogs = writable<boolean>(false);
	let showInfo = writable<boolean>(false);
	let sending = writable<boolean>(false);
	let sent = writable<boolean>(false);
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

<div class="modal-title">Send Bug Report</div>
<div class="modal-content system3-bug-report">
	{#if $sent}
		<div class="centered-message">
			<SettingItem
				name="Thank you!"
				description="Your bug report will help us improve Relay."
			></SettingItem>
		</div>
	{:else if $sending && !$sent}
		<div class="centered-message">
			<div id="spinner" class="d-flex align-items-center">
				<strong>Sending Bug Report...</strong>
				<div
					class="spinner-border ms-auto"
					role="status"
					aria-hidden="true"
				></div>
			</div>
		</div>
	{:else}
		<div class="report-container">
			<div class="form-content">
				<SettingItem
					name="Description"
					description="Please describe what went wrong and what you were trying to do."
				></SettingItem>
				<textarea
					bind:value={$bugDescription}
					placeholder="Describe the issue here..."
				></textarea>

				<SettingItem
					name="Include Logs"
					description="Send logs to the Relay developers to help them debug the issue."
				>
					<div
						role="checkbox"
						aria-checked={$includeLogs}
						tabindex="0"
						on:keypress={() => {}}
						class="checkbox-container"
						class:is-enabled={$includeLogs}
						on:click={() => {
							const newValue = !$includeLogs;
							includeLogs.set(newValue);
						}}
					>
						<input type="checkbox" tabindex="-1" checked={$includeLogs} />
						<div class="checkbox-toggle"></div>
					</div>
				</SettingItem>
				{#if $includeLogs}
					<SettingItem name="Logs" description="">
						<div slot="description">
							{#each $logFiles as lfile}
								<div>
									{`${lfile}\n`}
								</div>
							{/each}
						</div>
					</SettingItem>
				{/if}
			</div>

			<SettingItem name="" description="">
				<button
					disabled={$sending}
					on:click={async () => {
						let bugReport = "Bug Report\n\n";
						bugReport += JSON.stringify(
							{
								userAgent: navigator.userAgent,
								manifest: plugin.manifest,
								user: $anyPb?.authStore.model?.id,
								loadTime: plugin.loadTime,
								description: $bugDescription,
							},
							null,
							2,
						);
						bugReport += "\n\n";
						if (includeLogs) {
							const logs = await getAllLogs();
							bugReport += logs;
						}
						requestUrl({
							url: "https://bug-reports.system3.dev",
							method: "PUT",
							body: bugReport,
							headers: {
								"Content-Type": "text/plain",
							},
						}).then(() => {
							sent.set(true);
						});
						sending.set(true);
					}}>Send</button
				>
			</SettingItem>
		</div>
	{/if}
</div>

<style>
	.system3-bug-report {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 30em;
	}

	.report-container {
		display: flex;
		flex-direction: column;
		flex: 1;
	}

	.form-content {
		flex: 1;
		overflow-y: auto;
	}

	textarea {
		width: 100%;
		height: 300px;
		resize: vertical;
	}

	.centered-message {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		padding-bottom: 5em;
	}
</style>
