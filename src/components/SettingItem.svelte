<script lang="ts">
	export let name: string;
	export let description: string;

	const itemDescriptionLines =
		description !== undefined ? description.split("\n") : [];
</script>

<div class="setting-item">
	<div class="setting-item-info">
		<div class="setting-item-name">{name || ""}</div>
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
