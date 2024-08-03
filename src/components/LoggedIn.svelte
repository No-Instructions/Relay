<script lang="ts">
	import type Live from "../main";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type { LoginManager } from "src/LoginManager";

	export let plugin: Live;
	let lm: LoginManager;
	lm = plugin.loginManager;

	async function logout() {
		plugin.loginManager.logout();
	}

	async function login() {
		await plugin.loginManager.login();
	}
</script>

{#if $lm.hasUser}
	<SettingItemHeading name="Account" />
	<SettingItem
		name="Your account"
		description="You are currently logged in as: {$lm.user?.name}."
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
		<button
			on:click={async () => {
				await login();
			}}>Login with Google</button
		>
	</SettingItem>
{/if}

<style>
</style>
