import type { Workspace } from "obsidian";
import MetadataHealthNotice from "../components/MetadataHealthNotice.svelte";
import { mountComponent } from "./svelteHost.svelte";
import type { MetadataHealth } from "../MetadataHealth";
import { SidebarNoticeMount } from "./SidebarNoticeMount";

export class MetadataHealthSidebarNoticeMount extends SidebarNoticeMount {
	constructor(workspace: Workspace, metadataHealth: MetadataHealth) {
		super(workspace, "system3-metadata-health-slot", (target, anchor) =>
			mountComponent(MetadataHealthNotice, { target, anchor, props: { metadataHealth } }));
	}
}
