<script lang="ts">
	import type Live from "../main";
	import store from "../Store";
	import SettingItem from "./SettingItem.svelte";

	let plugin: Live;

	store.plugin.subscribe((p) => (plugin = p));

	import { onMount } from "svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	let isLoggedIn = false;

	onMount(async () => {
		isLoggedIn = await checkLoginStatus();
	});

	async function checkLoginStatus() {
		return plugin.loginManager.hasUser;
	}

	async function logout() {
		plugin.loginManager.logout();
		isLoggedIn = false;
	}

	async function login() {
		await plugin.loginManager.login();
		isLoggedIn = true;
	}
</script>

<h2>Relay</h2>
{#if isLoggedIn}
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
