<script lang="ts">
	import { debounce, Notice } from "obsidian";
	import type Live from "../main";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import Callout from "./Callout.svelte";
	import Discord from "./Discord.svelte";
	import RelayText from "./RelayText.svelte";
	import type { LoginManager } from "src/LoginManager";
	import { derived, writable } from "svelte/store";
	import { onMount } from "svelte";
	import type {
		AuthProviderInfo,
		RecordAuthResponse,
		RecordModel,
	} from "pocketbase";
	import { customFetch } from "src/customFetch";
	import ObjectState from "./ObjectState.svelte";

	export let plugin: Live;

	let lm: LoginManager;
	let automaticFlow = writable<boolean>(true);
	let pending = writable<boolean>(false);
	lm = plugin.loginManager;
	let timedOut = writable<boolean>(false);
	let success = writable<boolean>(false);
	let showLink = writable<boolean>(false);
	let useCustomFetch = writable<boolean>(true);

	let url = writable<string>("please wait...");
	let provider: AuthProviderInfo | undefined;
	let authWithCode: (code: string) => Promise<RecordAuthResponse<RecordModel>>;
	let error = writable<string>("");
	let debugLogs = writable<boolean>(plugin.settings.debugging);

	function toggleDebug() {
		debugLogs.set(plugin.toggleDebugging(true));
	}

	async function logout() {
		plugin.loginManager.logout();
		success.set(false);
		timedOut.set(false);
	}

	async function login() {
		try {
			await plugin.loginManager.login();
		} catch (e) {
			automaticFlow.set(false);
			success.set(false);
		}
	}

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

	const responseImpl = writable<string>(getResponse());
	const fetchImpl = writable<string>(getFetch());
	const usingBlink = writable<string>(getUsingBlink());
	const anyPb = writable<any>(plugin.loginManager.pb as any);

	function refresh() {
		responseImpl.set(getResponse());
		fetchImpl.set(getFetch());
		usingBlink.set(getUsingBlink());
		anyPb.set(plugin.loginManager.pb as any);
	}

	function initiate() {
		try {
			const whichFetch = $useCustomFetch ? customFetch : fetch;
			provider = undefined;
			url.set("please wait...");
			lm.initiateManualOAuth2CodeFlow(whichFetch)
				.then(([url_, provider_, authWithCode_]) => {
					provider = provider_;
					authWithCode = authWithCode_;
					url.set(url_);
				})
				.catch((e) => {
					let message = e.message;
					message = message + "\n" + getResponse();
					error.set(message);
					throw e;
				});
		} catch (e: any) {
			error.set(e.message);
		}
	}

	onMount(() => {
		success.set(false);
		initiate();
	});

	async function poll() {
		if (!provider || !authWithCode) {
			return;
		}
		return await plugin.loginManager
			.poll(provider, authWithCode)
			.then((authRecord) => {
				success.set(true);
				error.set("");
			})
			.catch((e) => {
				timedOut.set(true);
				success.set(false);
				error.set(e.message);
			});
	}

	function selectText(event: Event) {
		const inputEl = event.target as HTMLInputElement;
		inputEl.focus();
		inputEl.select();
		navigator.clipboard
			.writeText(inputEl.value)
			.then(() => new Notice("Invite link copied"))
			.catch((err) => {});
		poll();
	}
</script>

{#if $lm.hasUser}
	<RelayText />
	<Discord />
	<SettingItemHeading name="Account"></SettingItemHeading>
	<SettingItem
		name="Your account"
		description="You are currently logged in as: {$lm.user?.name}."
	>
		<button
			on:click={debounce(() => {
				logout();
			})}>Logout</button
		>
	</SettingItem>
	<slot></slot>
{:else}
	<SettingItemHeading name="Account">
		{#if $automaticFlow}
			<span id="login-issues"
				>login issues? try the <a
					href="#debug"
					role="button"
					tabindex="0"
					on:keypress={(e) => {
						if (e.key === "Enter") {
							$automaticFlow = !$automaticFlow;
						}
					}}
					on:click={() => {
						$automaticFlow = !$automaticFlow;
					}}>debug flow.</a
				>
			</span>
			|
			<Discord />
		{:else}
			<a
				href="#standard"
				role="button"
				tabindex="0"
				on:keydown={(e) => {
					if (e.key === "Enter") {
						$automaticFlow = !$automaticFlow;
					}
				}}
				on:click={() => {
					$automaticFlow = !$automaticFlow;
				}}><span>Back</span></a
			>
			|
			<Discord />
		{/if}
	</SettingItemHeading>
	{#if $automaticFlow}
		{#if !$pending}
			<SettingItem
				name="Login"
				description="You need to login to use this plugin."
			>
				<button
					on:click={debounce(async () => {
						await login();
					})}>Login with Google</button
				>
			</SettingItem>
		{:else}
			<SettingItem
				name="Login"
				description="Please complete the login flow in your browser and wait a few seconds."
			>
				<button
					class="mod-destructive"
					on:click={debounce(() => {
						pending.set(false);
					})}>Cancel</button
				>
			</SettingItem>
		{/if}
	{:else}
		<Callout title="Get Help">
			<p>
				We're working on improving the login process. Please <a
					href="https://discord.system3.md">join our Discord</a
				> and we will help you.
			</p>
		</Callout>
		{#if $error}
			<Callout title="Error">
				<p>{$error}</p>
			</Callout>
		{/if}
		<SettingItem
			name="Login"
			description="Please complete the login flow in your browser and wait a few seconds."
		>
			<a href={$url} target="_blank">
				<button
					disabled={$url === "please wait..."}
					on:click={() => {
						showLink.set(true);
						poll();
					}}>Login</button
				>
			</a>
		</SettingItem>
		<SettingItem
			name=""
			description="If your browser doesn't open, you can login manually by
			visiting this URL in your browser. Clicking will copy the link to your clipboard."
		>
			<input
				type="text"
				value={$url}
				readonly
				style="width: 100%"
				on:click={debounce(selectText)}
				id="system3AuthUrl"
			/>
		</SettingItem>

		{#if $timedOut}
			<SettingItem
				name="Check"
				description="Click here once you've completed login"
			>
				<button
					on:click={debounce(() => {
						poll();
					})}>Check</button
				>
			</SettingItem>
		{/if}
	{/if}
{/if}

<style>
</style>
