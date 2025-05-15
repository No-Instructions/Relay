<script lang="ts">
	import { User } from "../User";
	import Avatar from "./Avatar.svelte";
	import { createEventDispatcher } from "svelte";
	import { debounce } from "obsidian";
	import type { RelayUser } from "src/Relay";

	export let user: RelayUser;
</script>

<div class="setting-item">
	<Avatar size="2.5em" {user} />
	<div class="setting-item-info" style="display: grid">
		<div class="setting-item-description">
			{user.name || ""} <br />
			{user.email || ""}
		</div>
	</div>
	<div class="setting-item-control">
		<slot></slot>
	</div>
</div>

<style>
	.setting-item-control {
		width: unset !important;
		margin-top: unset !important;
	}
	.setting-item {
		flex-direction: unset !important;
		align-items: flex-start;
	}
	.setting-item-info {
		min-width: 0;
		margin-top: auto;
		margin-bottom: auto;
	}
</style>
