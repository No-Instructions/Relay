<script lang="ts">
	import { Platform } from "obsidian";
	import type Live from "../main";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type { OAuth2Url, LoginManager } from "src/LoginManager";

	export let plugin: Live;
	let lm: LoginManager;
	let url: OAuth2Url;

	lm = plugin.loginManager;
	url = plugin.loginManager.url;
	if (Platform.isIosApp) {
		plugin.loginManager.getLoginUrl();
	}

	async function logout() {
		plugin.loginManager.logout();
	}

	async function login() {
		await plugin.loginManager.login();
	}
</script>

<h1>Relay</h1>
{#if $lm.hasUser}
	<SettingItemHeading name="Account" />
	<SettingItem
		name="Your Account"
		description="You are currently logged in as: {$lm.user?.name}"
	>
		<button on:click={logout}>Logout</button>
	</SettingItem>
	<slot></slot>
{:else}
	<SettingItemHeading name="Account" />
	{#if Platform.isIosApp}
		<SettingItem
			name="Login"
			description="You need to login to use this plugin."
		>
			<a href={$url.url} target="_blank" rel="noopener noreferrer">
				<button on:click={login}>Login with Google</button>
			</a>
		</SettingItem>
		<hr />

		<div
			data-callout-metadata=""
			data-callout-fold=""
			data-callout="callout"
			class="callout"
			dir="auto"
		>
			<div class="callout-title" dir="auto">
				<div class="callout-icon" dir="auto">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="24"
						height="24"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="svg-icon lucide-pencil"
						><path
							d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"
						></path><path d="m15 5 4 4"></path></svg
					>
				</div>
				<div class="callout-title-inner" dir="auto">Note</div>
			</div>
			<div class="callout-content" dir="auto">
				<p dir="auto">
					Relay isn't quite working on iOS yet. We're working on it!
				</p>
				<p dir="auto">- Daniel @ No Instructions</p>
			</div>
		</div>
		<p class="debug-info">
			(debug: url took {$url.delay}ms to generate and is {$url.age}ms old)
		</p>
	{:else}
		<SettingItem
			name="Login"
			description="You need to login to use this plugin."
		>
			<button
				on:click={async () => {
					await login();
				}}>Login with Google</button
			>
		</SettingItem>
	{/if}
{/if}

<style>
	.debug-info {
		color: gray;
		position: absolute;
		bottom: 1em;
	}
</style>
