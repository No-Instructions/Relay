import type { App } from "obsidian";

export function openPluginPage(app: Pick<App, "workspace">, pluginId: string): void {
	const workspace = app.workspace as typeof app.workspace & {
		protocolHandler?: {
			dispatch?: (params: { action: string; id: string }) => void;
		};
	};
	try {
		// Dispatch in this vault when the internal API is available.
		if (typeof workspace.protocolHandler?.dispatch === "function") {
			workspace.protocolHandler.dispatch({ action: "show-plugin", id: pluginId });
			return;
		}
	} catch {
		// Obsidian internals vary by app version; use the public URI below.
	}
	window.open(`obsidian://show-plugin?id=${encodeURIComponent(pluginId)}`);
}
