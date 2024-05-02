<script lang="ts">
	export let itemName: string;
	export let itemDescription: string;

	const itemDescriptionLines = itemDescription.split("\n");
</script>

<div class="setting-item">
	<div class="setting-item-info">
		<div class="setting-item-name">{itemName}</div>
		<div class="setting-item-description">
			{#each itemDescriptionLines as itemDescriptionLine}
				<div>
					{itemDescriptionLine}
				</div>
			{/each}
		</div>
	</div>
	<div class="setting-item-control">
		<slot></slot>
	</div>
</div>
