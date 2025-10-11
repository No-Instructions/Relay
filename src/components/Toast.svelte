<script lang="ts">
	import {
		AlertTriangle,
		X,
		CheckCircle,
		Info,
		AlertCircle,
	} from "lucide-svelte";
	import { createEventDispatcher, onMount } from "svelte";

	export let message: string;
	export let details: string = "";
	export let type: "error" | "warning" | "info" | "success" = "error";
	export let autoDismiss: number = 5000;

	const dispatch = createEventDispatcher();
	let timeoutId: number;

	onMount(() => {
		if (autoDismiss > 0) {
			timeoutId = window.setTimeout(() => {
				dispatch("dismiss");
			}, autoDismiss);
		}

		return () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	});

	function handleDismiss() {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		dispatch("dismiss");
	}

	$: iconComponent =
		type === "error"
			? AlertTriangle
			: type === "warning"
				? AlertCircle
				: type === "success"
					? CheckCircle
					: Info;

	$: toastClass = `toast toast-${type}`;
</script>

<div class={toastClass} role="alert" aria-live="polite">
	<div class="toast-icon">
		<svelte:component this={iconComponent} class="svg-icon" />
	</div>

	<div class="toast-content">
		<div class="toast-message">{message}</div>
		{#if details}
			<div class="toast-details">{details}</div>
		{/if}
	</div>

	<button
		class="toast-dismiss"
		on:click={handleDismiss}
		aria-label="Dismiss error"
	>
		<X class="svg-icon" />
	</button>
</div>

<style>
	.toast {
		position: absolute;
		top: 20px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 16px;
		border-radius: 8px;
		border: 1px solid;
		background: var(--background-primary);
		color: var(--text-normal);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		min-height: 48px;
		max-width: 500px;
		min-width: 300px;
		width: max-content;
		animation: slideDown 0.3s ease-out;
		pointer-events: auto;
	}

	.toast-error {
		border-color: var(--text-error);
	}

	.toast-warning {
		border-color: var(--text-warning);
	}

	.toast-success {
		border-color: var(--text-success, #4caf50);
	}

	.toast-info {
		border-color: var(--interactive-accent);
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			transform: translateX(-50%) translateY(-10px);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) translateY(0);
		}
	}

	.toast-icon {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.toast-error .toast-icon {
		color: var(--text-error);
	}

	.toast-warning .toast-icon {
		color: var(--text-warning);
	}

	.toast-success .toast-icon {
		color: var(--text-success, #4caf50);
	}

	.toast-info .toast-icon {
		color: var(--interactive-accent);
	}

	.toast-content {
		flex: 1;
		min-width: 0;
	}

	.toast-message {
		font-weight: 500;
		margin-bottom: 2px;
		line-height: 1.4;
		color: var(--text-normal);
	}

	.toast-details {
		font-size: 0.9em;
		color: var(--text-muted);
		line-height: 1.3;
	}

	.toast-dismiss {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: none;
		background: transparent;
		border-radius: 4px;
		cursor: pointer;
		color: var(--text-muted);
		transition: all 0.15s ease-in-out;
		padding: 0;
		flex-shrink: 0;
	}

	.toast-dismiss:hover {
		background: var(--background-modifier-hover);
		color: var(--text-error);
	}

	.toast-dismiss:focus {
		outline: 2px solid var(--interactive-accent);
		outline-offset: 1px;
	}
</style>
