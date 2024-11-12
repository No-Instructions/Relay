<script lang="ts">
	import { User } from "../User";
	import { Platform } from "obsidian";
	import Avatar from "./Avatar.svelte";

	export let user: User;
</script>

<div class="setting-item">
	{#if !Platform.isMobile}
		<Avatar size="2.5em" {user} />
	{/if}
	<div class="setting-item-info" style="display: grid">
		<div class="setting-item-description">
			{user.name} <br />
			{user.email}
		</div>
	</div>
	<div class="setting-item-control">
		<slot></slot>
	</div>
</div>
