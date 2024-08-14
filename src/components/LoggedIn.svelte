<script lang="ts">
	import { debounce, Notice } from "obsidian";
	import type Live from "../main";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import Callout from "./Callout.svelte";
	import type { LoginManager } from "src/LoginManager";
	import { writable } from "svelte/store";
	import { onMount } from "svelte";
	import type {
		AuthProviderInfo,
		RecordAuthResponse,
		RecordModel,
	} from "pocketbase";
	import { customFetch } from "src/customFetch";

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
	let authWithCode: (
		code: string,
	) => Promise<RecordAuthResponse<RecordModel>>;
	let error = writable<string>("");
	let debugLogs = writable<boolean>(plugin.settings.debugging);

	function toggleDebug() {
		debugLogs.set(plugin.toggleDebugging(true));
	}

	async function logout() {
		await plugin.loginManager.logout();
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
					error.set(e.message);
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
	<SettingItemHeading name="Account" />
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
			<a href="https://discord.system3.md"
				><span
					><svg
						width="1em"
						height="1em"
						viewBox="0 -28.5 256 256"
						version="1.1"
						xmlns="http://www.w3.org/2000/svg"
						xmlns:xlink="http://www.w3.org/1999/xlink"
						preserveAspectRatio="xMidYMid"
					>
						<g>
							<path
								d="M216.856339,16.5966031 C200.285002,8.84328665 182.566144,3.2084988 164.041564,0 C161.766523,4.11318106 159.108624,9.64549908 157.276099,14.0464379 C137.583995,11.0849896 118.072967,11.0849896 98.7430163,14.0464379 C96.9108417,9.64549908 94.1925838,4.11318106 91.8971895,0 C73.3526068,3.2084988 55.6133949,8.86399117 39.0420583,16.6376612 C5.61752293,67.146514 -3.4433191,116.400813 1.08711069,164.955721 C23.2560196,181.510915 44.7403634,191.567697 65.8621325,198.148576 C71.0772151,190.971126 75.7283628,183.341335 79.7352139,175.300261 C72.104019,172.400575 64.7949724,168.822202 57.8887866,164.667963 C59.7209612,163.310589 61.5131304,161.891452 63.2445898,160.431257 C105.36741,180.133187 151.134928,180.133187 192.754523,160.431257 C194.506336,161.891452 196.298154,163.310589 198.110326,164.667963 C191.183787,168.842556 183.854737,172.420929 176.223542,175.320965 C180.230393,183.341335 184.861538,190.991831 190.096624,198.16893 C211.238746,191.588051 232.743023,181.531619 254.911949,164.955721 C260.227747,108.668201 245.831087,59.8662432 216.856339,16.5966031 Z M85.4738752,135.09489 C72.8290281,135.09489 62.4592217,123.290155 62.4592217,108.914901 C62.4592217,94.5396472 72.607595,82.7145587 85.4738752,82.7145587 C98.3405064,82.7145587 108.709962,94.5189427 108.488529,108.914901 C108.508531,123.290155 98.3405064,135.09489 85.4738752,135.09489 Z M170.525237,135.09489 C157.88039,135.09489 147.510584,123.290155 147.510584,108.914901 C147.510584,94.5396472 157.658606,82.7145587 170.525237,82.7145587 C183.391518,82.7145587 193.761324,94.5189427 193.539891,108.914901 C193.539891,123.290155 183.391518,135.09489 170.525237,135.09489 Z"
								fill="#5865F2"
								fill-rule="nonzero"
							>
							</path>
						</g>
					</svg>
				</span>
			</a>
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
			<a href="https://discord.system3.md"
				><span
					><svg
						width="1em"
						height="1em"
						viewBox="0 -28.5 256 256"
						version="1.1"
						xmlns="http://www.w3.org/2000/svg"
						xmlns:xlink="http://www.w3.org/1999/xlink"
						preserveAspectRatio="xMidYMid"
					>
						<g>
							<path
								d="M216.856339,16.5966031 C200.285002,8.84328665 182.566144,3.2084988 164.041564,0 C161.766523,4.11318106 159.108624,9.64549908 157.276099,14.0464379 C137.583995,11.0849896 118.072967,11.0849896 98.7430163,14.0464379 C96.9108417,9.64549908 94.1925838,4.11318106 91.8971895,0 C73.3526068,3.2084988 55.6133949,8.86399117 39.0420583,16.6376612 C5.61752293,67.146514 -3.4433191,116.400813 1.08711069,164.955721 C23.2560196,181.510915 44.7403634,191.567697 65.8621325,198.148576 C71.0772151,190.971126 75.7283628,183.341335 79.7352139,175.300261 C72.104019,172.400575 64.7949724,168.822202 57.8887866,164.667963 C59.7209612,163.310589 61.5131304,161.891452 63.2445898,160.431257 C105.36741,180.133187 151.134928,180.133187 192.754523,160.431257 C194.506336,161.891452 196.298154,163.310589 198.110326,164.667963 C191.183787,168.842556 183.854737,172.420929 176.223542,175.320965 C180.230393,183.341335 184.861538,190.991831 190.096624,198.16893 C211.238746,191.588051 232.743023,181.531619 254.911949,164.955721 C260.227747,108.668201 245.831087,59.8662432 216.856339,16.5966031 Z M85.4738752,135.09489 C72.8290281,135.09489 62.4592217,123.290155 62.4592217,108.914901 C62.4592217,94.5396472 72.607595,82.7145587 85.4738752,82.7145587 C98.3405064,82.7145587 108.709962,94.5189427 108.488529,108.914901 C108.508531,123.290155 98.3405064,135.09489 85.4738752,135.09489 Z M170.525237,135.09489 C157.88039,135.09489 147.510584,123.290155 147.510584,108.914901 C147.510584,94.5396472 157.658606,82.7145587 170.525237,82.7145587 C183.391518,82.7145587 193.761324,94.5189427 193.539891,108.914901 C193.539891,123.290155 183.391518,135.09489 170.525237,135.09489 Z"
								fill="#5865F2"
								fill-rule="nonzero"
							>
							</path>
						</g>
					</svg>
				</span>
			</a>
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

		<SettingItemHeading name="Advanced" />
		<SettingItem
			name="Custom fetch"
			description="Uses requestUrl to avoid CORS preflight checks."
		>
			<div
				aria-label="custom fetch can help avoid some network restrictions"
				on:click={() => {
					useCustomFetch.set(!$useCustomFetch);
					initiate();
				}}
				role="checkbox"
				aria-checked={$useCustomFetch}
				tabindex="0"
				on:keydown={debounce((e) => {
					if (e.key === "Enter") {
						useCustomFetch.set(!$useCustomFetch);
						initiate();
					}
				})}
				class="checkbox-container mod-small {$useCustomFetch
					? 'is-enabled'
					: ''}"
			>
				<input
					type="checkbox"
					tabindex="0"
					bind:checked={$useCustomFetch}
				/>
			</div>
		</SettingItem>

		<SettingItem
			name="Debug logs"
			description="Enable debug logs to help diagnose issues."
		>
			<div
				aria-label="custom fetch can help avoid some network restrictions"
				on:click={() => {
					toggleDebug();
				}}
				role="checkbox"
				aria-checked={$debugLogs}
				tabindex="0"
				on:keydown={debounce((e) => {
					if (e.key === "Enter") {
						toggleDebug();
					}
				})}
				class="checkbox-container mod-small {$debugLogs
					? 'is-enabled'
					: ''}"
			>
				<input type="checkbox" tabindex="0" bind:checked={$debugLogs} />
			</div>
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
	#login-issues {
		color: var(--color-base-40);
	}
</style>
