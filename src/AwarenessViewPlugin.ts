import { HasLogging } from "./debug";
import { View } from "obsidian";
import UserAwareness from "./components/UserAwareness.svelte";
import { trackPromise } from "./trackPromise";
import type { HasProvider } from "./HasProvider";

export interface AwarenessHost {
	/** The Obsidian view whose containerEl owns the avatar overlay. */
	view: View;
	/**
	 * The provider-backed doc (Document or Canvas). Must expose `_provider`,
	 * `whenReady()`, `guid`, and optionally `path` for logger tagging.
	 */
	doc: HasProvider & { whenReady(): Promise<unknown>; path?: string };
	/**
	 * Resolves the anchor inside `containerEl` that the avatar element is
	 * inserted relative to, along with the insertion position. Called once
	 * during `install()`. Returning `null` skips mounting.
	 */
	resolveAnchor(containerEl: HTMLElement): {
		anchor: HTMLElement;
		position: InsertPosition;
	} | null;
	/** Extra class applied to the container (e.g. layout variant). */
	variantClass?: string;
	/** Optional hook to apply inline styles after the container is inserted. */
	configureContainer?: (el: HTMLElement) => void;
	/** Lay out the stack vertically (column) instead of horizontally (row). */
	vertical?: boolean;
}

export class AwarenessViewPlugin extends HasLogging {
	private host: AwarenessHost;
	private destroyed = false;
	private awarenessComponent?: UserAwareness;
	private awarenessElement?: HTMLElement;
	private relayUsersStore: any;

	constructor(host: AwarenessHost, relayUsersStore: any) {
		super();
		this.host = host;
		this.relayUsersStore = relayUsersStore;
		this.setLoggers(`[AwarenessView](${this.host.doc.path ?? this.host.doc.guid})`);
		this.install();
	}

	private async install() {
		if (!this.host || this.destroyed) return;

		this.log("Installing awareness component");

		// Wrap the title immediately to avoid focus loss later
		this.wrapTitle();

		// Wait for the document to be ready
		await trackPromise(
			`awareness:whenReady:${this.host.doc.guid}`,
			this.host.doc.whenReady(),
		);

		if (this.destroyed) return;

		// Mount the Svelte component (needs awareness to be available)
		this.mountAwarenessComponent();
	}

	private wrapTitle() {
		const containerEl = this.host.view?.containerEl;
		if (!containerEl || this.destroyed) return;

		// Already created
		if (this.awarenessElement) return;

		const resolved = this.host.resolveAnchor(containerEl);
		if (!resolved) {
			this.warn("Could not resolve anchor for awareness component");
			return;
		}

		// Create container for the awareness component
		this.awarenessElement = document.createElement("div");
		this.awarenessElement.className = "user-awareness-container";
		if (this.host.variantClass) {
			this.awarenessElement.classList.add(this.host.variantClass);
		}

		resolved.anchor.insertAdjacentElement(resolved.position, this.awarenessElement);

		this.host.configureContainer?.(this.awarenessElement);

		// The CSS pins the container top-right of its positioning parent. Make
		// sure that parent can host absolute children.
		const positioningParent =
			resolved.position === "afterbegin" || resolved.position === "beforeend"
				? resolved.anchor
				: resolved.anchor.parentElement;
		if (positioningParent) {
			positioningParent.style.position = "relative";
		}
	}

	private mountAwarenessComponent() {
		if (!this.awarenessElement || this.destroyed) return;

		// Get the awareness instance from the provider
		const provider = this.host.doc._provider;
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
					vertical: this.host.vertical ?? false,
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

		this.host = null as any;
	}
}
