<script lang="ts">
	import { Folder } from "lucide-svelte";

	interface hasName {
		name: string;
	}

	export let folder: hasName;
</script>

<span style="display: inline-flex; align-items: center">
	<Folder
		class="svg-icon"
		style="margin-right: .2em; width: 1em;"
	/>{folder.name}
</span>
