<script lang="ts">
	export let name: HTMLSpanElement | string = "";
	export let description: string;

	const itemDescriptionLines =
		description !== undefined ? description.split("\n") : [];
</script>

<div class="setting-item">
	<div class="setting-item-info" style="display: grid">
		<div
			class="setting-item-name"
			style="display: grid; align-items: center"
		>
			<slot name="name">{name}</slot>
		</div>
		<div class="setting-item-description">
			<slot name="description">
				{#if itemDescriptionLines.length > 0}
					{#each itemDescriptionLines as itemDescriptionLine}
						<div>
							{itemDescriptionLine}
						</div>
					{/each}
				{/if}
			</slot>
		</div>
	</div>
	<div class="setting-item-control">
		<slot></slot>
	</div>
</div>
