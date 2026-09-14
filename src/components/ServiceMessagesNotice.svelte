<script lang="ts">
	import { onDestroy } from "svelte";
	import type NetworkStatus from "src/NetworkStatus";
	import type { ServiceMessage, ServiceMessages } from "src/ServiceMessages";
	import SidebarNotice from "./SidebarNotice.svelte";

	export let networkStatus: NetworkStatus;
	export let messages: ServiceMessages;
	export let slotClass = "system3-service-messages-slot";
	let visible: readonly ServiceMessage[] = [];
	const unsubscribeMessages = messages.subscribe(next => { visible = next; });
	const unsubscribeNetwork = networkStatus.subscribeServiceMessages(next => messages.update(next));
	onDestroy(() => {
		unsubscribeNetwork();
		unsubscribeMessages();
	});
</script>

{#each visible as message (message.id)}
	<SidebarNotice
		title={message.title}
		dismissLabel={`Dismiss ${message.title}`}
		className="service-message-notice"
		{slotClass}
		onDismiss={() => messages.dismiss(message.id)}
	>
		{message.message}
		{#if message.link}
			<a href={message.link} target="_blank" rel="noopener noreferrer">More information</a>
		{/if}
	</SidebarNotice>
{/each}
