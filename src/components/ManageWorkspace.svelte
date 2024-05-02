<script lang="ts">
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type { Workspace } from "../Workspace";
	export let workspace: Workspace;
</script>

<SettingItemHeading name={workspace.name}></SettingItemHeading>
