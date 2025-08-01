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
	import type { LoginManager, Provider } from "src/LoginManager";
	import { derived, writable } from "svelte/store";
	import { onMount } from "svelte";
	import type {
		AuthProviderInfo,
		RecordAuthResponse,
		RecordModel,
	} from "pocketbase";
	import { customFetch } from "src/customFetch";
	import { FeatureFlagManager, flags } from "src/flagManager";

	export let plugin: Live;

	let lm: LoginManager;
	let automaticFlow = writable<boolean>(!Platform.isIosApp);
	let pending = writable<boolean>(false);
	lm = plugin.loginManager;
	let timedOut = writable<boolean>(false);
	let success = writable<boolean>(false);
	let useCustomFetch = writable<boolean>(true);
	let selectedProvider = writable<string>("");
	let flagManager = FeatureFlagManager.getInstance();

	let providers: Record<string, Provider> = {};
	let hasProviderInfo = writable<boolean>(false);
	const loginSettings = lm.loginSettings;

	const enabledProviders = derived([selectedProvider, flagManager], () => {
		const availableProviders = ["google"];

		if ($flagManager.getFlag("enableMicrosoftLogin")) {
			availableProviders.push("microsoft");
		}

		if ($flagManager.getFlag("enableDiscordLogin")) {
			availableProviders.push("discord");
		}
		return availableProviders;
	});

	const visibleProviders = derived(
		[selectedProvider, lm.loginSettings, flagManager],
		() => {
			// First check the loginSettings store
			if ($loginSettings && $loginSettings.provider)
				return [$loginSettings.provider];

			// Fall back to selectedProvider for compatibility
			if ($selectedProvider !== "") return [$selectedProvider];
			const visible = ["google"];

			if ($flagManager.getFlag("enableMicrosoftLogin")) {
				visible.push("microsoft");
			}

			if ($flagManager.getFlag("enableDiscordLogin")) {
				visible.push("discord");
			}

			return visible;
		},
	);

	function clearPreferredProvider() {
		lm.clearPreferredProvider();
		selectedProvider.set("");
		initiate();
	}

	const configuredProviders = derived(
		[selectedProvider, plugin.loginSettings, flagManager, hasProviderInfo],
		() => {
			if ($selectedProvider) return [$selectedProvider];
			return Object.keys(providers);
		},
	);

	let authWithCode: (code: string) => Promise<RecordAuthResponse<RecordModel>>;
	let error = writable<string>("");

	async function logout() {
		plugin.loginManager.logout();
		success.set(false);
		pending.set(false);
		selectedProvider.set("");
		timedOut.set(false);
	}

	async function login(providerName = "google") {
		try {
			selectedProvider.set(providerName);
			const loginSuccess = await plugin.loginManager.login(providerName);
			if (loginSuccess) {
				success.set(true);
			}
		} catch (e) {
			automaticFlow.set(false);
			success.set(false);
			const provider = providers[providerName];
			if (provider) {
				window.open(provider.fullAuthUrl, "_blank");
				poll(providerName);
			}
		}
	}

	const anyPb = writable<any>(plugin.loginManager.pb as any);

	function refresh() {
		anyPb.set(plugin.loginManager.pb as any);
	}

	function initiate() {
		try {
			const whichFetch = $useCustomFetch ? customFetch : fetch;
			lm.initiateManualOAuth2CodeFlow(whichFetch, $enabledProviders)
				.then((providers_) => {
					providers = providers_;
					hasProviderInfo.set(true);
				})
				.catch((e) => {
					let message = e.message;
					message = message;
					error.set(message);
					success.set(false);
					selectedProvider.set("");
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

	async function poll(providerName = "google") {
		const provider = providers[providerName];
		if (!provider) {
			return;
		}
		selectedProvider.set(providerName);
		return await plugin.loginManager
			.poll(provider)
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
		poll($selectedProvider);
	}

	function capitalize(s: string): string {
		if (!s) return "";
		return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
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
			<div class="login-buttons">
				{#each $visibleProviders as provider}
					<button
						class={`${provider}-sign-in-button`}
						disabled={$pending || !$configuredProviders.contains(provider)}
						on:click={debounce(async () => {
							pending.set(true);
							await login(provider);
						})}>Sign in with {`${capitalize(provider)}`}</button
					>
				{/each}
			</div>
		{:else}
			<div class="login-buttons">
				{#each $visibleProviders as provider}
					{#if providers[provider]}
						<a href={providers[provider].fullAuthUrl} target="_blank">
							<button
								class={`${provider}-sign-in-button`}
								disabled={$pending || !providers[provider]}
								on:click={() => {
									pending.set(true);
									poll();
								}}>Sign in with {`${capitalize(provider)}`}</button
							>
						</a>
					{:else}
						<button class={`${provider}-sign-in-button`} disabled={true}
							>Sign in with {`${capitalize(provider)}`}</button
						>
					{/if}
				{/each}
			</div>
		{/if}
		{#if $error}
			<p>
				{$error}.<br />
				{#if $timedOut}
					Already logged in? <button
						class="link link-button"
						on:click={debounce(() => {
							poll($selectedProvider || "google");
						})}>(click here)</button
					>
				{/if}
			</p>
			<p class="not-working">
				Not working?
				<button
					class="link link-button"
					on:click={() => {
						pending.set(false);
						automaticFlow.set(false);
						error.set("");
						selectedProvider.set("");
						hasProviderInfo.set(false);
						initiate();
					}}>(try again)</button
				>
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
							automaticFlow.set(false);
							error.set("");
							selectedProvider.set("");
						}}>(try again)</button
					>
				</p>
			</div>
		{/if}
	</div>
	{#if $loginSettings.provider && !$pending}
		<p class="choose-another">
			<button
				class="link link-button"
				on:click={debounce(() => {
					clearPreferredProvider();
				})}>(choose another provider)</button
			>
		</p>
	{/if}
	<WelcomeFooter
		isGoogle={!flags().enableDiscordLogin && !flags().enableMicrosoftLogin}
	/>
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
		width: 100%;
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
		font-family:
			-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
			Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
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

	.discord-sign-in-button {
		width: 100%;
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
		font-family:
			-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
			Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
		background-image: url(data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+PHN2ZyAgIHdpZHRoPSIxOCIgICBoZWlnaHQ9IjE4IiAgIHZpZXdCb3g9Ii0xNSAtMTUgMjg2IDI4NiIgICBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJ4TWlkWU1pZCIgICB2ZXJzaW9uPSIxLjEiICAgaWQ9InN2ZzYiICAgc29kaXBvZGk6ZG9jbmFtZT0iZGlzY29yZC5zdmciICAgaW5rc2NhcGU6dmVyc2lvbj0iMS4xLjIgKDBhMDBjZjUzMzksIDIwMjItMDItMDQpIiAgIHhtbG5zOmlua3NjYXBlPSJodHRwOi8vd3d3Lmlua3NjYXBlLm9yZy9uYW1lc3BhY2VzL2lua3NjYXBlIiAgIHhtbG5zOnNvZGlwb2RpPSJodHRwOi8vc29kaXBvZGkuc291cmNlZm9yZ2UubmV0L0RURC9zb2RpcG9kaS0wLmR0ZCIgICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciICAgeG1sbnM6c3ZnPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+ICA8ZGVmcyAgICAgaWQ9ImRlZnMxMCIgLz4gIDxzb2RpcG9kaTpuYW1lZHZpZXcgICAgIGlkPSJuYW1lZHZpZXc4IiAgICAgcGFnZWNvbG9yPSIjZmZmZmZmIiAgICAgYm9yZGVyY29sb3I9IiM2NjY2NjYiICAgICBib3JkZXJvcGFjaXR5PSIxLjAiICAgICBpbmtzY2FwZTpwYWdlc2hhZG93PSIyIiAgICAgaW5rc2NhcGU6cGFnZW9wYWNpdHk9IjAuMCIgICAgIGlua3NjYXBlOnBhZ2VjaGVja2VyYm9hcmQ9IjAiICAgICBzaG93Z3JpZD0iZmFsc2UiICAgICBpbmtzY2FwZTp6b29tPSIyNC4yNSIgICAgIGlua3NjYXBlOmN4PSI0LjM3MTEzNCIgICAgIGlua3NjYXBlOmN5PSIxNC40NTM2MDgiICAgICBpbmtzY2FwZTp3aW5kb3ctd2lkdGg9IjE4OTAiICAgICBpbmtzY2FwZTp3aW5kb3ctaGVpZ2h0PSIxMDY0IiAgICAgaW5rc2NhcGU6d2luZG93LXg9IjE4OTAiICAgICBpbmtzY2FwZTp3aW5kb3cteT0iMTA5NiIgICAgIGlua3NjYXBlOndpbmRvdy1tYXhpbWl6ZWQ9IjAiICAgICBpbmtzY2FwZTpjdXJyZW50LWxheWVyPSJzdmc2IiAvPiAgPGcgICAgIGlkPSJnNCIgICAgIHRyYW5zZm9ybT0ibWF0cml4KDEuMDg4NzYxMiwwLDAsMS4wNDc4NTU0LC0xMC40NTgyNzYsMzMuNDI2NTI1KSI+ICAgIDxwYXRoICAgICAgIGQ9Ik0gMjE2Ljg1NjM0LDE2LjU5NjYwMyBDIDIwMC4yODUsOC44NDMyODY3IDE4Mi41NjYxNCwzLjIwODQ5ODggMTY0LjA0MTU2LDAgYyAtMi4yNzUwNCw0LjExMzE4MTEgLTQuOTMyOTQsOS42NDU0OTkxIC02Ljc2NTQ2LDE0LjA0NjQzOCAtMTkuNjkyMTEsLTIuOTYxNDQ4IC0zOS4yMDMxMywtMi45NjE0NDggLTU4LjUzMzA4NCwwIEMgOTYuOTEwODQyLDkuNjQ1NDk5MSA5NC4xOTI1ODQsNC4xMTMxODExIDkxLjg5NzE4OSwwIDczLjM1MjYwNywzLjIwODQ5ODggNTUuNjEzMzk1LDguODYzOTkxMiAzOS4wNDIwNTgsMTYuNjM3NjYxIDUuNjE3NTIyOSw2Ny4xNDY1MTQgLTMuNDQzMzE5MSwxMTYuNDAwODEgMS4wODcxMTA3LDE2NC45NTU3MiAyMy4yNTYwMiwxODEuNTEwOTEgNDQuNzQwMzYzLDE5MS41Njc3IDY1Ljg2MjEzMywxOTguMTQ4NTggYyA1LjIxNTA4MiwtNy4xNzc0NSA5Ljg2NjIzLC0xNC44MDcyNSAxMy44NzMwODEsLTIyLjg0ODMyIC03LjYzMTE5NSwtMi44OTk2OSAtMTQuOTQwMjQyLC02LjQ3ODA2IC0yMS44NDY0MjcsLTEwLjYzMjMgMS44MzIxNzQsLTEuMzU3MzcgMy42MjQzNDMsLTIuNzc2NTEgNS4zNTU4MDMsLTQuMjM2NyA0Mi4xMjI4MiwxOS43MDE5MyA4Ny44OTAzNCwxOS43MDE5MyAxMjkuNTA5OTMsMCAxLjc1MTgyLDEuNDYwMTkgMy41NDM2MywyLjg3OTMzIDUuMzU1ODEsNC4yMzY3IC02LjkyNjU0LDQuMTc0NiAtMTQuMjU1NTksNy43NTI5NyAtMjEuODg2NzksMTAuNjUzIDQuMDA2ODUsOC4wMjAzNyA4LjYzOCwxNS42NzA4NyAxMy44NzMwOCwyMi44NDc5NyAyMS4xNDIxMywtNi41ODA4OCA0Mi42NDY0LC0xNi42MzczMSA2NC44MTUzMywtMzMuMjEzMjEgNS4zMTU4LC01Ni4yODc1MiAtOS4wODA4NiwtMTA1LjA4OTQ3NyAtMzguMDU1NjEsLTE0OC4zNTkxMTcgeiBNIDg1LjQ3Mzg3NSwxMzUuMDk0ODkgYyAtMTIuNjQ0ODQ3LDAgLTIzLjAxNDY1MywtMTEuODA0NzMgLTIzLjAxNDY1MywtMjYuMTc5OTkgMCwtMTQuMzc1MjUzIDEwLjE0ODM3MywtMjYuMjAwMzQxIDIzLjAxNDY1MywtMjYuMjAwMzQxIDEyLjg2NjYzMSwwIDIzLjIzNjA4NSwxMS44MDQzODQgMjMuMDE0NjU1LDI2LjIwMDM0MSAwLjAyLDE0LjM3NTI2IC0xMC4xNDgwMjQsMjYuMTc5OTkgLTIzLjAxNDY1NSwyNi4xNzk5OSB6IG0gODUuMDUxMzY1LDAgYyAtMTIuNjQ0ODUsMCAtMjMuMDE0NjYsLTExLjgwNDczIC0yMy4wMTQ2NiwtMjYuMTc5OTkgMCwtMTQuMzc1MjUzIDEwLjE0ODAzLC0yNi4yMDAzNDEgMjMuMDE0NjYsLTI2LjIwMDM0MSAxMi44NjYyOCwwIDIzLjIzNjA4LDExLjgwNDM4NCAyMy4wMTQ2NSwyNi4yMDAzNDEgMCwxNC4zNzUyNiAtMTAuMTQ4MzcsMjYuMTc5OTkgLTIzLjAxNDY1LDI2LjE3OTk5IHoiICAgICAgIGZpbGw9IiM1ODY1ZjIiICAgICAgIGZpbGwtcnVsZT0ibm9uemVybyIgICAgICAgaWQ9InBhdGgyIiAvPiAgPC9nPjwvc3ZnPg==);
		background-color: var(--background-secondary);
		background-repeat: no-repeat;
		background-position: 12px 11px;
	}

	.discord-sign-in-button:hover {
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 2px 4px rgba(0, 0, 0, 0.25);
	}

	.discord-sign-in-button:disabled {
		cursor: unset;
		filter: grayscale(100%);
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 1px 1px rgba(0, 0, 0, 0.25);
	}

	.microsoft-sign-in-button {
		width: 100%;
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
		font-family:
			-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
			Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
		background-image: url(data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIHdpZHRoPSIxOHB4IiBoZWlnaHQ9IjE4cHgiIHZpZXdCb3g9Ii0xNSAtMTUgMjg2IDI4NiIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHByZXNlcnZlQXNwZWN0UmF0aW89InhNaWRZTWlkIj4gICAgPHRpdGxlPk1pY3Jvc29mdDwvdGl0bGU+ICAgIDxnPiAgICAgICAgPHBvbHlnb24gZmlsbD0iI0YxNTExQiIgcG9pbnRzPSIxMjEuNjY2MDk1IDEyMS42NjYwOTUgMCAxMjEuNjY2MDk1IDAgMCAxMjEuNjY2MDk1IDAiLz4gICAgICAgIDxwb2x5Z29uIGZpbGw9IiM4MENDMjgiIHBvaW50cz0iMjU2IDEyMS42NjYwOTUgMTM0LjMzNTM1NiAxMjEuNjY2MDk1IDEzNC4zMzUzNTYgMCAyNTYgMCIvPiAgICAgICAgPHBvbHlnb24gZmlsbD0iIzAwQURFRiIgcG9pbnRzPSIxMjEuNjYzMTk0IDI1Ni4wMDIxODggMCAyNTYuMDAyMTg4IDAgMTM0LjMzNjA5NSAxMjEuNjYzMTk0IDEzNC4zMzYwOTUiLz4gICAgICAgIDxwb2x5Z29uIGZpbGw9IiNGQkJDMDkiIHBvaW50cz0iMjU2IDI1Ni4wMDIxODggMTM0LjMzNTM1NiAyNTYuMDAyMTg4IDEzNC4zMzUzNTYgMTM0LjMzNjA5NSAyNTYgMTM0LjMzNjA5NSIvPiAgICA8L2c+PC9zdmc+);
		background-color: var(--background-secondary);
		background-repeat: no-repeat;
		background-position: 12px 11px;
	}

	.microsoft-sign-in-button:hover {
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 2px 4px rgba(0, 0, 0, 0.25);
	}

	.microsoft-sign-in-button:disabled {
		cursor: unset;
		filter: grayscale(100%);
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 1px 1px rgba(0, 0, 0, 0.25);
	}

	.login-buttons {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 1rem;
		background: var(--background-modifier-border-hover);
		border-radius: 0.5rem;
	}

	.choose-another {
		text-align: center;
		margin-top: 0.25rem;
		margin-bottom: 1rem;
		font-size: 0.85em;
		color: var(--text-normal);
	}
</style>
