import { HasLogging } from "./debug";
import { MarkdownView } from "obsidian";
import { Document } from "./Document";
import { type LiveView } from "./LiveViews";
import UserAwareness from "./components/UserAwareness.svelte";
import type { RelayUser } from "./Relay";
export class AwarenessViewPlugin extends HasLogging {
	view: LiveView<MarkdownView>;
	doc: Document;
	private destroyed = false;
	private awarenessComponent?: UserAwareness;
	private targetElement?: HTMLElement;
	private awarenessElement?: HTMLElement;
	private relayUsersStore: any;

	constructor(view: LiveView<MarkdownView>, relayUsersStore: any) {
		super();
		this.view = view;
		this.doc = view.document;
		this.relayUsersStore = relayUsersStore;
		this.setLoggers(`[AwarenessView](${this.doc.path})`);
		this.install();
	}

	private async install() {
		if (!this.view || this.destroyed) return;

		this.log("Installing awareness component for", this.view.view.file?.path);

		// Wrap the title immediately to avoid focus loss later
		this.wrapTitle();

		// Wait for the document to be ready
		await this.doc.whenReady();

		if (this.destroyed) return;

		// Mount the Svelte component (needs awareness to be available)
		this.mountAwarenessComponent();
	}

	private wrapTitle() {
		if (!this.view.view.containerEl || this.destroyed) return;

		// Already created
		if (this.awarenessElement) return;

		// Find the target element (inline-title) to position relative to
		const inlineTitle = this.view.view.containerEl.querySelector(
			".inline-title",
		) as HTMLElement;
		if (!inlineTitle) {
			this.warn(
				"Could not find inline-title element to position awareness component",
			);
			return;
		}

		// Create container for the awareness component
		this.awarenessElement = document.createElement("div");
		this.awarenessElement.className = "user-awareness-container";

		// Insert as sibling after the inline-title (more robust than wrapping)
		// Use absolute positioning via CSS to place it next to the title
		inlineTitle.insertAdjacentElement("afterend", this.awarenessElement);

		// Make the parent position relative so we can position absolutely
		const parent = inlineTitle.parentElement;
		if (parent) {
			parent.style.position = "relative";
		}
	}

	private mountAwarenessComponent() {
		if (!this.awarenessElement || this.destroyed) return;

		// Get the awareness instance from the provider
		const provider = this.doc._provider;
		if (!provider?.awareness) {
			this.warn("No awareness provider available");
			return;
		}

		// Create and mount the Svelte component
		try {
			this.awarenessComponent = new UserAwareness({
				target: this.awarenessElement,
				props: {
					awareness: provider.awareness,
					relayUsers: this.relayUsersStore,
				},
			});

			this.log("Awareness component successfully mounted");
		} catch (error) {
			this.warn("Failed to create awareness component:", error);
		}
	}

	destroy() {
		this.destroyed = true;

		if (this.awarenessComponent) {
			try {
				this.awarenessComponent.$destroy();
				this.awarenessComponent = undefined;
				this.log("Awareness component destroyed");
			} catch (error) {
				this.warn("Error destroying awareness component:", error);
			}
		}

		if (this.awarenessElement) {
			this.awarenessElement.remove();
			this.awarenessElement = undefined;
		}

		this.view = null as any;
		this.doc = null as any;
	}
}
