<script lang="ts">
	export let name: HTMLSpanElement | string = "";
</script>

<div class="setting-item setting-item-heading">
	<div class="setting-item-info">
		<div class="setting-item-name">
			<slot name="name">{name}</slot>
		</div>
		<slot name="description">
			<div class="setting-item-description">
				<slot name="description"></slot>
			</div>
		</slot>
	</div>
	<div class="setting-item-control">
		<slot></slot>
	</div>
</div>
