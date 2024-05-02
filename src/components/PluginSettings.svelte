<script lang="ts">
	import LoggedIn from "./LoggedIn.svelte";
	import Workspaces from "./Workspaces.svelte";
	import ManageWorkspace from "./ManageWorkspace.svelte";
	import type { Workspace } from "../Workspace";
	import ModalSettingsNav from "./ModalSettingsNav.svelte";

	interface ManageWorkspaceEventDetail {
		workspace: Workspace;
	}
	interface ManageWorkspaceEvent
		extends CustomEvent<ManageWorkspaceEventDetail> {}
	interface GoBackEvent extends CustomEvent {}

	let currentComponent: typeof Workspaces | typeof ManageWorkspace =
		Workspaces;
	let currentWorkspace: Workspace | null = null;

	function handleManageWorkspaceEvent(event: ManageWorkspaceEvent) {
		currentWorkspace = event.detail.workspace;
		currentComponent = ManageWorkspace;
	}
	function handleGoBack(event: GoBackEvent) {
		currentWorkspace = null;
		currentComponent = Workspaces;
	}
</script>

<div class="vertical-tab-content-container">
	{#if currentWorkspace}
		<ModalSettingsNav on:goBack={handleGoBack}></ModalSettingsNav>
	{/if}
	<div class="vertical-tab-content">
		{#if currentWorkspace}
			<ManageWorkspace workspace={currentWorkspace}></ManageWorkspace>
		{:else}
			<LoggedIn>
				<Workspaces on:manageWorkspace={handleManageWorkspaceEvent}
				></Workspaces>
			</LoggedIn>
		{/if}
	</div>
</div>
