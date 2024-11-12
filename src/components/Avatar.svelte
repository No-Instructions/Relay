<script lang="ts">
	export let src = "";
	export let alt = "Profile picture";
	export let size = "40px";

	// Optional: fallback for broken images
	function handleError(e) {
		// You could set a fallback image here
		e.target.style.backgroundColor = "#ddd";
	}
</script>

<div class="avatar" style:width={size} style:height={size}>
	<img {src} {alt} on:error={handleError} />
</div>

<style>
	.avatar {
		position: relative;
		border-radius: 50%;
		overflow: hidden;
		background-color: #ddd; /* Placeholder color before image loads */
		display: flex;
		align-items: center;
		justify-content: center;
	}

	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
