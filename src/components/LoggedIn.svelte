<script lang="ts">
	import type Live from "../main";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type { OAuth2Url, LoginManager } from "src/LoginManager";

	export let plugin: Live;
	let userSet: LoginManager;
	let url: OAuth2Url;

	userSet = plugin.loginManager;
	url = plugin.loginManager.url;
	plugin.loginManager.getLoginUrl();

	async function logout() {
		plugin.loginManager.logout();
	}

	async function login() {
		await plugin.loginManager.login();
	}
</script>

<h2>Relay</h2>
{#if $userSet.items().length > 0}
	<SettingItemHeading name="Account" />
	<SettingItem
		name="Logged In"
		description="User: {plugin.loginManager.user.name}"
	>
		<button on:click={logout}>Logout</button>
	</SettingItem>
	<slot></slot>
{:else}
	<SettingItemHeading name="Account" />
	<SettingItem
		name="Login"
		description="You need to login to use this plugin."
	>
		<button on:click={login}>Login with Google</button>
	</SettingItem>
	<a href={$url.url} target="_blank" rel="noopener noreferrer">
		Login with Google
	</a>
	(debug: url took {$url.delay}ms to generate and is {$url.age}ms old)
{/if}
