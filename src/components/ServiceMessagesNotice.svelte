<script lang="ts">
	import { onDestroy } from "svelte";
	import type { ServiceMessage, ServiceMessages, ServiceMessageAction } from "src/ServiceMessages";
	import SidebarNotice from "./SidebarNotice.svelte";
	import ServiceMessageActions from "./ServiceMessageActions.svelte";
	import { minimark } from "../minimark";

	export let messages: ServiceMessages;
	export let onAction: (action: ServiceMessageAction) => void;
	export let slotClass = "system3-service-messages-slot";
	let message: ServiceMessage | null = null;
	const unsubscribeMessages = messages.subscribe(next => { message = next; });
	onDestroy(() => {
		unsubscribeMessages();
	});
</script>

{#if message}
	<SidebarNotice
		title={message.title}
		dismissLabel={`Dismiss ${message.title}`}
		className="service-message-notice"
		backgroundColor={message.backgroundColor}
		color={message.color}
		{slotClass}
		onDismiss={() => { if (message) messages.dismiss(message.id); }}
	>
		{@html minimark(message.message)}
		{#if message.link}
			<a href={message.link} target="_blank" rel="noopener noreferrer">More information</a>
		{/if}
		<ServiceMessageActions actions={message.actions ?? []} {onAction} />
	</SidebarNotice>
{/if}
