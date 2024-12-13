<script lang="ts">
	export let onToggle: (checked: boolean) => {}
	export let name: string
	export let isChecked: boolean

	function toggleFlag() {
		isChecked = !isChecked
		onToggle(isChecked);
	}

	onMount(() => {
			const toggleEl = document.getElementById(`toggle-${name}`);
			if (toggleEl) {
				setIcon(toggleEl, "check");
			}
		});
	});
</script>

<div class="setting-item-control">
	<div
		role="checkbox"
		aria-checked={isChecked}
		tabindex="0"
		on:keypress={() => {
			toggleFlag();
		}}
		class="checkbox-container"
		class:is-enabled={isChecked}
		on:click={() => toggleFlag()}
	>
		<input type="checkbox" checked={value} />
		<div class="checkbox-toggle"></div>
	</div>
</div>
