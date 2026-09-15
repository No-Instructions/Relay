<script lang="ts">
	import type { ServiceMessage, ServiceMessageAction } from "../ServiceMessages";
	import { minimark } from "../minimark";
	import RelayMark from "./RelayMark.svelte";
	import ServiceMessageActions from "./ServiceMessageActions.svelte";
	export let message: ServiceMessage;
	export let onAction: (action: ServiceMessageAction) => void;
</script>

<div class="system3-note-service-message" role="status">
	<span class="relay-mark"><RelayMark /></span>
	<div class="content">
		<strong>{message.title}</strong>
		<span>{@html minimark(message.message)}</span>
		{#if message.link}<a href={message.link} target="_blank" rel="noopener noreferrer">More information</a>{/if}
		<ServiceMessageActions actions={message.actions} {onAction} />
	</div>
</div>

<style>
	.system3-note-service-message { display: flex; align-items: baseline; gap: var(--size-4-2); width: 100%; color: inherit; font-size: var(--font-ui-small); line-height: 1.5; }
	.relay-mark { display: inline-flex; flex: 0 0 14px; align-self: flex-start; margin-top: 3px; }
	.content { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 var(--size-4-2); }
	.content :global(.service-message-actions) { display: inline-flex; margin: 0; }
	.content :global(button), a { color: inherit; text-decoration: underline; }
</style>
