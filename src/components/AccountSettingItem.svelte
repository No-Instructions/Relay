<script lang="ts">
	import { User } from "../User";
	import Avatar from "./Avatar.svelte";
	import { createEventDispatcher } from "svelte";
	import { debounce } from "obsidian";

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
