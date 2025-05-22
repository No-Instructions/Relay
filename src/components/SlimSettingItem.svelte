<script lang="ts">
	export let name: HTMLSpanElement | string = "";
	export let description: string = "";
</script>

<div class="setting-item mod-list-item">
	<div class="setting-item-info">
		<div class="setting-item-name truncate">
			<slot name="name">{name}</slot>
		</div>
		<slot name="description">
			{#if description}
				<div class="setting-item-description">{description}</div>
			{/if}
		</slot>
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
	}
	.setting-item-info {
		min-width: 0;
		margin-top: auto;
		margin-bottom: auto;
	}
	.setting-item-name {
		min-width: 0;
	}
	.truncate :global(*) {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
