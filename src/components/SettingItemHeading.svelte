<script lang="ts">
	export let name: string;
	export let description = "";
</script>

<div class="setting-item setting-item-heading">
	<div class="setting-item-info">
		<div class="setting-item-name">{name}</div>
		<div class="setting-item-description">{description}</div>
	</div>
	<div class="setting-item-control">
		<slot></slot>
	</div>
</div>
