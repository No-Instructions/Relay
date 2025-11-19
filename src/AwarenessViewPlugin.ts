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

		// Wait for the document to be ready
		await this.doc.whenReady();

		if (this.destroyed) return;

		// Set up the awareness component immediately - it will handle connection states
		this.setupAwarenessComponent();
	}

	private setupAwarenessComponent() {
		if (!this.view.view.containerEl || this.destroyed) return;

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

		// Create a wrapper div to contain both title and avatars
		const titleWrapper = document.createElement("div");
		titleWrapper.className = "title-with-awareness";
		titleWrapper.style.display = "flex";
		titleWrapper.style.alignItems = "center";
		titleWrapper.style.justifyContent = "space-between";
		titleWrapper.style.width = "100%";

		// Create container for the awareness component
		this.awarenessElement = document.createElement("div");
		this.awarenessElement.className = "user-awareness-container";

		// Wrap the inline title and add the awareness container
		if (inlineTitle.parentNode) {
			inlineTitle.parentNode.insertBefore(titleWrapper, inlineTitle);
			titleWrapper.appendChild(inlineTitle);
			titleWrapper.appendChild(this.awarenessElement);
		}

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
			// Find the wrapper and restore the original title structure
			const titleWrapper = this.awarenessElement.parentElement;
			if (titleWrapper && titleWrapper.className === "title-with-awareness") {
				const inlineTitle = titleWrapper.querySelector(".inline-title");
				if (inlineTitle && titleWrapper.parentNode) {
					titleWrapper.parentNode.insertBefore(inlineTitle, titleWrapper);
					titleWrapper.remove();
				}
			} else {
				this.awarenessElement.remove();
			}
			this.awarenessElement = undefined;
		}

		this.view = null as any;
		this.doc = null as any;
	}
}
