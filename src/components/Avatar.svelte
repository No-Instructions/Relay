<script lang="ts">
	import { User } from "../User";

	export let user: User;
	export let alt = "Profile picture";
	export let size = "40px";

	let imageError = false;

	function handleError() {
		imageError = true;
	}

	function extractUnit(value: string) {
		return value.match(/[a-z]+$/i)?.[0] || "px";
	}

	$: initial = user.name ? user.name.charAt(0).toUpperCase() : "?";
	$: unit = extractUnit(size);
	$: fontSize = `${parseFloat(size) / 2}${unit}`;
</script>

<div class="avatar" style:width={size} style:height={size}>
	{#if !imageError && user.picture}
		<img src={user.picture} {alt} on:error={handleError} />
	{:else}
		<span class="initial" style:font-size={fontSize}>
			{initial}
		</span>
	{/if}
</div>

<style>
	.avatar {
		position: relative;
		border-radius: 50%;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--color-base-30);
	}

	.initial {
		color: var(--text-on-accent);
	}

	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
