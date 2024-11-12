<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingsControl from "./SettingsControl.svelte";
	import HelpPopover from "./HelpPopover.svelte";
	import { type Relay, type RelayRole } from "../Relay";
	import type Live from "src/main";
	import { Satellite } from "lucide-svelte";
	import type { ObservableMap } from "src/observable/ObservableMap";
	import { derived } from "svelte/store";
	import type { SharedFolder } from "src/SharedFolder";
	import SharedFolderSpan from "./SharedFolderSpan.svelte";
	import { debounce } from "obsidian";

	export let plugin: Live;
	export let relays: ObservableMap<string, Relay>;

	const sharedFolders = plugin.sharedFolders;

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

	function handleShareKeyInput() {
		invalidShareKey = false;
	}

	async function handleJoinRelayFromInvite(shareKey: string) {
		try {
			const relay = await plugin.relayManager.acceptInvitation(shareKey);
			dispatch("joinRelay", { relay });
		} catch (e) {
			invalidShareKey = true;
		}
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

<SettingItemHeading name="Join a relay"></SettingItemHeading>
<SettingItem
	name="Share key"
	description="Enter the code that was shared with you."
>
	<input
		type="text"
		placeholder="Enter share key"
		bind:value={shareKey}
		on:input={handleShareKeyInput}
		class={invalidShareKey ? "system3-input-invalid" : ""}
	/>
	<button
		class="mod-cta"
		on:click={debounce(() => handleJoinRelayFromInvite(shareKey))}
		>Join relay</button
	>
</SettingItem>

<SettingItemHeading>
	<span slot="name" style="display: inline-flex; align-items: center">
		Relay servers
		<HelpPopover helpText="A relay server coordinates real-time updates between collaborators. You can add collaborators and share folders on the Relay settings page." />
	</span>
</SettingItemHeading>
{#each $relays.values().sort(sortFn) as relay}
	<SettingItem description="">
		<span slot="name" style="display: inline-flex"
			><Satellite class="svg-icon" />
			{#if relay.name}
				{relay.name}
			{:else}
				<span class="faint">(Untitled Relay)</span>
			{/if}
		</span>
		<SettingsControl
			on:settings={() => {
				handleManageRelay(relay);
			}}
		></SettingsControl>
	</SettingItem>
{/each}
<SettingItem name="" description="">
	<button class="mod-cta" on:click={debounce(() => handleCreateRelay())}
		>New relay</button
	>
</SettingItem>

<SettingItemHeading name="Shared folders"></SettingItemHeading>
{#if $sharedFolders.items().length === 0}
	<SettingItem
		description="Go to a Relay server's setting page above to share existing folders, or add shared folders to your vault."
	/>
{/if}
{#each $sharedFolders.items() as folder}
	<SettingItem description="">
		<SharedFolderSpan {folder} slot="name" />
		<SettingsControl
			on:settings={debounce(() => {
				const relay = $relays.values().find((relay) => {
					return folder.remote?.relay.guid === relay.guid;
				});
				handleManageSharedFolder(folder, relay);
			})}
		></SettingsControl>
	</SettingItem>
{/each}

<style>
	input.system3-input-invalid {
		border: 1px solid var(--color-red) !important;
	}
	span.faint {
		color: var(--text-faint);
	}
</style>
