<script lang="ts">
	import { Plus, Minus } from "lucide-svelte";

	export let currentQuantity: number = 5;

	let selectedQuantity: number = currentQuantity;

	$: actionText = selectedQuantity === currentQuantity ? "Manage" : "Modify";

	function increment() {
		selectedQuantity++;
	}

	function decrement() {
		if (selectedQuantity > 3) {
			selectedQuantity--;
		}
	}

	function handleInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		let newValue = parseInt(input.value, 10);
		if (isNaN(newValue) || newValue < 3) {
			newValue = 3;
		}
		selectedQuantity = newValue;
	}

	function handleAction() {
		alert(`Button clicked: ${actionText}`);
	}
</script>

{#if currentQuantity !== 3}
	<div class="seat-manager">
		<button on:click={decrement}><Minus class="svg-icon" /></button>
		<input
			type="number"
			bind:value={selectedQuantity}
			min="3"
			on:change={handleInputChange}
		/>
		<button on:click={increment}><Plus class="svg-icon" /></button>
	</div>
{/if}

<style>
	.seat-manager {
		display: flex;
		border-radius: 4px;
		overflow: hidden;
		font-family: Arial, sans-serif;
	}
	.seat-manager button {
		background: none;
		border: none;
		cursor: pointer;
		padding: 10px;
		font-size: 16px;
		color: #333;
	}
	.seat-manager input {
		border: none;
		text-align: center;
		font-size: 16px;
		width: 50px;
		padding: 10px 0;
		-moz-appearance: textfield;
	}
	.seat-manager input::-webkit-outer-spin-button,
	.seat-manager input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}
</style>
