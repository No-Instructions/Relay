<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingsControl from "./SettingsControl.svelte";
	import { type Relay, type RelayRoleUser, type RelayRole } from "../Relay";
	import store from "../Store";
	import type Live from "src/main";
	import { Satellite, Folder, Settings, ArrowRightLeft } from "lucide-svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import { derived } from "svelte/store";
	import type { SharedFolder } from "src/SharedFolder";
	import SharedFolderSpan from "./SharedFolderSpan.svelte";

	export let plugin: Live;
	export let relays: ObservableMap<string, Relay>;
	export let relayRoles: ObservableMap<string, RelayRole>;

	let loginManager = plugin.loginManager;
	const user = derived(loginManager, ($loginManager) => {
		const lm = $loginManager;
		return lm.user;
	});
	store.plugin.subscribe((p) => {
		plugin = p;
	});

	const sharedFolders = plugin.sharedFolders;
	console.log(sharedFolders);

	let myRoles = derived(relayRoles, ($relayRoles) => {
		return $relayRoles.filter((role) => role.userId === $user?.id);
	});

	let ownerOf = derived(relayRoles, ($relayRoles) => {
		return $relayRoles
			.filter(
				(role) => role.role === "Owner" && role.userId === $user?.id,
			)
			.values();
	});

	let memberOf = derived(relayRoles, ($relayRoles) => {
		return $relayRoles.filter(
			(role) => role.role === "Member" && role.userId === $user?.id,
		);
	});

	let ownerOrMemberOf = derived(relayRoles, ($relayRoles) => {
		return $relayRoles.filter(
			(role) =>
				role.role === "Member" ||
				(role.role === "Owner" && role.userId === $user?.id),
		);
	});

	let visibleRelays = derived(relays, ($relays) => {
		return $relays.filter((relay) => {
			return $relayRoles.some(
				(role) =>
					role.relay?.guid === relay.guid &&
					(role.role === "Owner" || role.role === "Member"),
			);
		});
	});

	let shareKey = "";
	let invalidShareKey = false;

	const dispatch = createEventDispatcher();

	function handleManageRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("manageRelay", { relay });
	}
	function handleManageSharedFolder(folder: SharedFolder, relay?: Relay) {
		if (!folder) {
			return;
		}
		dispatch("manageSharedFolder", { folder, relay });
	}

	function handleJoinRelay(relay?: Relay) {
		if (!relay) {
			return;
		}
		dispatch("joinRelay", { relay });
	}
	function handleShareKeyInput() {
		invalidShareKey = false;
	}
	function handleJoinRelayFromInvite(shareKey: string) {
		plugin.relayManager
			.acceptInvitation(shareKey)
			.then((relay) => {
				dispatch("joinRelay", { relay });
			})
			.catch((error) => {
				invalidShareKey = true;
			});
	}

	function handleCreateRelay() {
		dispatch("createRelay");
	}
	function sortFn(a: Relay, b: Relay): number {
		if (a.owner && !b.owner) {
			return -1;
		}
		if (b.owner && !a.owner) {
			return 1;
		}
		return a.name > b.name ? 1 : -1;
	}
</script>

<SettingItemHeading name="Join a Relay" description=""></SettingItemHeading>
<SettingItem
	name="Share Key"
	description="Enter the code that was shared with you"
>
	<input
		type="text"
		placeholder="Enter Share Key"
		bind:value={shareKey}
		on:input={handleShareKeyInput}
		class={invalidShareKey ? "system3-input-invalid" : ""}
	/>
	<button class="mod-cta" on:click={() => handleJoinRelayFromInvite(shareKey)}
		>Join Relay</button
	>
</SettingItem>

<SettingItemHeading name="Relays"></SettingItemHeading>
{#each $visibleRelays.values().sort(sortFn) as relay}
	<SettingItem description="">
		<span slot="name" style="display: inline-flex"
			><Satellite class="svg-icon" />{relay.name}
		</span>
		<SettingsControl
			on:settings={() => {
				handleManageRelay(relay);
			}}
		></SettingsControl>
	</SettingItem>
{/each}
<SettingItem name="" description="">
	<button class="mod-cta" on:click={() => handleCreateRelay()}
		>New Relay</button
	>
</SettingItem>

<SettingItemHeading name="Shared Folders"></SettingItemHeading>
{#each $sharedFolders.items() as folder}
	<SettingItem description="">
		<SharedFolderSpan {folder} slot="name" />
		<SettingsControl
			on:settings={() => {
				const relay = $relays.values().find((relay) => {
					return folder.remote?.relay.guid === relay.guid;
				});
				handleManageSharedFolder(folder, relay);
			}}
		></SettingsControl>
	</SettingItem>
{/each}

<style>
	input.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}
</style>
