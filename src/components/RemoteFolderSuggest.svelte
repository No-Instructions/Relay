<script lang="ts">
	import type { RemoteSharedFolder } from "../Relay";
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import GenericSuggest from "./GenericSuggest.svelte";

	export let availableFolders: RemoteSharedFolder[];
	export let placeholder: string = "Search folders...";
	export let autofocus: boolean = false;
	export let onSelect: (folder: RemoteSharedFolder) => void = () => {};

	function getRemoteFolderSuggestions(query: string): RemoteSharedFolder[] {
		const lowerQuery = query.toLowerCase();

		const filtered = availableFolders
			.filter((folder) => {
				const name = (folder.name || "").toLowerCase();
				const relayName = (folder.relay?.name || "").toLowerCase();
				return (
					!!folder.relay.name &&
					folder.name &&
					(name.includes(lowerQuery) || relayName.includes(lowerQuery))
				);
			})
			.sort((a, b) => {
				const aText = `${a.relay.name} / ${a.name}`;
				const bText = `${b.relay.name} / ${b.name}`;
				return aText.localeCompare(bText);
			});

		// Limit to 100 suggestions
		return filtered.slice(0, 100);
	}
</script>

<GenericSuggest
	{placeholder}
	{autofocus}
	{onSelect}
	getSuggestions={getRemoteFolderSuggestions}
	instructions={[
		{ command: "↑/↓", purpose: "Navigate" },
		{ command: "Enter", purpose: "Add folder to vault" },
		{ command: "Esc", purpose: "Cancel" },
	]}
>
	<svelte:fragment slot="suggestion" let:item>
		<Breadcrumbs
			element="div"
			items={[
				{ type: "relay", relay: item.relay },
				{ type: "remoteFolder", remoteFolder: item },
			]}
		/>
	</svelte:fragment>
</GenericSuggest>
