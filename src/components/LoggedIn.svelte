<script lang="ts">
	import { debounce, Notice, Platform } from "obsidian";
	import type Live from "../main";
	import GetInTouch from "./GetInTouch.svelte";
	import WelcomeHeader from "./WelcomeHeader.svelte";
	import WelcomeFooter from "./WelcomeFooter.svelte";
	import AccountSettingItem from "./AccountSettingItem.svelte";
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

	export let plugin: Live;

	let lm: LoginManager;
	let automaticFlow = writable<boolean>(!Platform.isIosApp);
	let pending = writable<boolean>(false);
	lm = plugin.loginManager;
	let timedOut = writable<boolean>(false);
	let success = writable<boolean>(false);
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
			if ($url && $url !== "please wait...") {
				window.open($url, "_blank");
				poll();
			}
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
				pending.set(false);
				error.set("");
			})
			.catch((e) => {
				timedOut.set(true);
				pending.set(false);
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

{#if $lm.hasUser && $lm.user}
	<SettingItemHeading>
		<RelayText slot="name" />
		<GetInTouch />
	</SettingItemHeading>
	<SettingItemHeading name="Account"></SettingItemHeading>
	<AccountSettingItem user={$lm.user}>
		<button
			on:click={debounce(() => {
				logout();
			})}>Logout</button
		>
	</AccountSettingItem>
	<slot></slot>
{:else}
	<div class="welcome">
		<WelcomeHeader />
		{#if $automaticFlow}
			<button
				class="google-sign-in-button"
				disabled={$pending}
				on:click={debounce(async () => {
					pending.set(true);
					await login();
				})}>Sign in with Google</button
			>
		{:else}
			<a href={$url} target="_blank">
				<button
					class="google-sign-in-button"
					disabled={$pending}
					on:click={() => {
						pending.set(true);
						poll();
					}}>Sign in with Google</button
				>
			</a>
		{/if}
		{#if $error}
			<p>
				{$error}.<br />
				{#if $timedOut}
					Already logged in? <button
						class="link link-button"
						on:click={debounce(() => {
							poll();
						})}>(click here)</button
					>
				{/if}
			</p>
		{:else if $pending}
			<div>
				<p class="continue">Continue in your browser...</p>
				<p class="not-working">
					Not working?
					<button
						class="link link-button"
						on:click={() => {
							pending.set(false);
						}}>(try again)</button
					>
				</p>
			</div>
		{/if}
	</div>
	<WelcomeFooter />
{/if}

<style>
	.continue {
		font-weight: 600;
		font-size: larger;
		margin-top: 0;
		margin-bottom: 0px;
	}
	.link {
		color: var(--text-muted);
	}

	.link:hover {
		color: var(--text-normal);
	}

	.not-working {
		margin-top: 0px;
		margin-bottom: 0px;
		color: var(--text-faint);
		font-size: 0.75em;
	}

	.link-button {
		box-shadow: none;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		text-decoration: underline;
	}

	button.link-button:hover {
		box-shadow: none;
		color: var(--text-normal);
	}

	button.link.link-button {
		height: auto;
		padding: 0;
		color: var(--text-faint);
	}

	.welcome {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 7rem 2rem 1rem 2rem;
		max-width: 640px;
		margin: 0 auto;
		gap: 2rem;
	}

	.google-sign-in-button {
		height: unset;
		padding: 12px 16px 12px 42px !important;
		border: none;
		border-radius: 3px;
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 1px 1px rgba(0, 0, 0, 0.25);
		color: var(--text-color);
		font-size: 14px;
		font-weight: 500;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
			Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
		background-image: url(data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTgiIGhlaWdodD0iMTgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIj48cGF0aCBkPSJNMTcuNiA5LjJsLS4xLTEuOEg5djMuNGg0LjhDMTMuNiAxMiAxMyAxMyAxMiAxMy42djIuMmgzYTguOCA4LjggMCAwIDAgMi42LTYuNnoiIGZpbGw9IiM0Mjg1RjQiIGZpbGwtcnVsZT0ibm9uemVybyIvPjxwYXRoIGQ9Ik05IDE4YzIuNCAwIDQuNS0uOCA2LTIuMmwtMy0yLjJhNS40IDUuNCAwIDAgMS04LTIuOUgxVjEzYTkgOSAwIDAgMCA4IDV6IiBmaWxsPSIjMzRBODUzIiBmaWxsLXJ1bGU9Im5vbnplcm8iLz48cGF0aCBkPSJNNCAxMC43YTUuNCA1LjQgMCAwIDEgMC0zLjRWNUgxYTkgOSAwIDAgMCAwIDhsMy0yLjN6IiBmaWxsPSIjRkJCQzA1IiBmaWxsLXJ1bGU9Im5vbnplcm8iLz48cGF0aCBkPSJNOSAzLjZjMS4zIDAgMi41LjQgMy40IDEuM0wxNSAyLjNBOSA5IDAgMCAwIDEgNWwzIDIuNGE1LjQgNS40IDAgMCAxIDUtMy43eiIgZmlsbD0iI0VBNDMzNSIgZmlsbC1ydWxlPSJub256ZXJvIi8+PHBhdGggZD0iTTAgMGgxOHYxOEgweiIvPjwvZz48L3N2Zz4=);
		background-color: var(--background-secondary);
		background-repeat: no-repeat;
		background-position: 12px 11px;
	}

	.google-sign-in-button:hover {
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 2px 4px rgba(0, 0, 0, 0.25);
	}

	.google-sign-in-button:disabled {
		cursor: unset;
		filter: grayscale(100%);
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 1px 1px rgba(0, 0, 0, 0.25);
	}
</style>
