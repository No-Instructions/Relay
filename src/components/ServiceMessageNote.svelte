<script lang="ts">
	import { X } from "lucide-svelte";
	import type { ServiceMessage, ServiceMessageAction } from "../ServiceMessages";
	import { minimark } from "../minimark";
	import ServiceMessageActions from "./ServiceMessageActions.svelte";
	export let message: ServiceMessage;
	export let onAction: (action: ServiceMessageAction) => void;
	export let onDismiss: () => void;
</script>

<div class="service-message-frame">
	<div class="system3-note-service-message" role="status">
		<div class="content">
			<strong>{message.title}</strong>
			<span>{@html minimark(message.message)}</span>
			{#if message.link}<a href={message.link} target="_blank" rel="noopener noreferrer">More information</a>{/if}
			<ServiceMessageActions actions={message.actions} {onAction} />
		</div>
		<button class="clickable-icon service-message-close" type="button" aria-label={`Dismiss ${message.title}`} on:click={onDismiss}>
			<X size={14} />
		</button>
	</div>
</div>

<style>
	.service-message-frame { width: 100%; min-width: 0; box-sizing: border-box; }
	:global(.system3-banner):has(> .service-message-frame) { position: relative; padding: var(--file-margins); padding-block: 6px; }
	:global(.system3-banner) > .service-message-frame { padding-inline-end: var(--scrollbar-width, 12px); }
	:global(.system3-banner) .service-message-close { position: absolute; inset-block-start: 5px; inset-inline-end: 20px; }
	:global(.workspace-leaf-content:has(> .view-content > .is-readable-line-width) .system3-banner) .system3-note-service-message {
		width: max-content;
		min-width: min(100%, var(--file-line-width));
		max-width: 100%;
		margin-inline: auto;
	}
	.system3-note-service-message { display: flex; align-items: flex-start; gap: var(--size-4-2); width: 100%; color: inherit; font-size: var(--font-ui-small); line-height: 1.5; }
	.content { display: flex; flex: 1; min-width: 0; align-items: baseline; flex-wrap: wrap; gap: 0 var(--size-4-2); overflow-wrap: anywhere; }
	.content :global(.service-message-actions) { display: inline-flex; margin: 0; }
	.content :global(button), a { color: inherit; text-decoration: underline; }
	.service-message-close { flex: 0 0 auto; width: 22px; height: 22px; padding: 0; color: inherit; box-shadow: none; }
</style>
