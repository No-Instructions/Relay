<script lang="ts">
	import type Live from "../main";
	import store from "../Store";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type { OAuth2Url, LoginManager } from "src/LoginManager";

	export let plugin: Live;
	let userSet: LoginManager = plugin.loginManager;
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
{/if}
