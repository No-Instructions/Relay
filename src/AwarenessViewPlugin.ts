import { HasLogging } from "./debug";
import UserAwareness from "./components/UserAwareness.svelte";
import { trackPromise } from "./trackPromise";
import type { HasProvider } from "./HasProvider";

export interface AwarenessHost {
	/** The Obsidian view whose containerEl owns the avatar overlay. */
	view: { containerEl: HTMLElement };
	/**
	 * The provider-backed doc (Document or Canvas). Must expose `_provider`,
	 * `whenReady()`, `guid`, and optionally `path` for logger tagging.
	 */
	doc: HasProvider & { whenReady(): Promise<unknown>; path?: string };
	/**
	 * Resolves the anchor inside `containerEl` that the avatar element is
	 * inserted relative to, along with the insertion position. Called whenever
	 * the host view refreshes. Returning `null` skips mounting.
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
	/**
	 * Optional accessor for the CM6-backed editor this awareness surface is
	 * attached to. When present, the popover exposes attribution controls.
	 */
	getEditor?: () => unknown;
}

export interface AwarenessAnchor {
	anchor: HTMLElement;
	position: InsertPosition;
}

export function resolveMarkdownAwarenessAnchor(
	containerEl: HTMLElement,
	mode: "preview" | "source",
): AwarenessAnchor | null {
	const modeRoot = containerEl.querySelector(
		mode === "preview" ? ".markdown-reading-view" : ".markdown-source-view",
	) as HTMLElement | null;
	const inlineTitle = modeRoot?.querySelector(
		".inline-title",
	) as HTMLElement | null;
	if (inlineTitle) {
		return { anchor: inlineTitle, position: "afterend" };
	}

	const modeContent = modeRoot?.querySelector(
		mode === "preview" ? ".markdown-preview-sizer" : ".cm-sizer",
	) as HTMLElement | null;
	if (modeContent) {
		return { anchor: modeContent, position: "afterbegin" };
	}

	const viewContent = containerEl.querySelector(
		".view-content",
	) as HTMLElement | null;
	return viewContent
		? { anchor: viewContent, position: "afterbegin" }
		: null;
}

export class AwarenessViewPlugin extends HasLogging {
	private host: AwarenessHost;
	private destroyed = false;
	private ready = false;
	private awarenessComponent?: UserAwareness;
	private awarenessElement?: HTMLElement;
	private positioningParent?: HTMLElement;
	private addedPositioningClass = false;
	private relayUsersStore: any;

	constructor(host: AwarenessHost, relayUsersStore: any) {
		super();
		this.host = host;
		this.relayUsersStore = relayUsersStore;
		this.setLoggers(`[AwarenessView](${this.host.doc.path ?? this.host.doc.guid})`);
		void this.install().catch((error) => {
			if (!this.destroyed) {
				this.warn("install failed", error);
			}
		});
	}

	private async install() {
		if (!this.host || this.destroyed) return;

		this.log("Installing awareness component");

		// Create the empty container immediately to avoid focus loss later.
		this.refresh();

		// Wait for the document to be ready
		await trackPromise(
			`awareness:whenReady:${this.host.doc.guid}`,
			this.host.doc.whenReady(),
		);

		if (this.destroyed) return;

		this.ready = true;
		this.refresh();
	}

	public refresh() {
		if (this.destroyed) return;

		const containerEl = this.host.view?.containerEl;
		if (!containerEl) return;

		const resolved = this.host.resolveAnchor(containerEl);
		if (!resolved) {
			this.warn("Could not resolve anchor for awareness component");
			return;
		}

		if (!this.awarenessElement) {
			this.awarenessElement = containerEl.ownerDocument.createElement("div");
			this.awarenessElement.className = "user-awareness-container";
			if (this.host.variantClass) {
				this.awarenessElement.classList.add(this.host.variantClass);
			}
		}

		if (!this.isAtResolvedAnchor(resolved)) {
			const inserted = resolved.anchor.insertAdjacentElement(
				resolved.position,
				this.awarenessElement,
			);
			if (!inserted) {
				this.warn("Could not insert awareness component at resolved anchor");
				return;
			}
		}

		this.host.configureContainer?.(this.awarenessElement);

		// The CSS pins the container top-right of its positioning parent. Make
		// sure that parent can host absolute children.
		this.setPositioningParent(
			resolved.position === "afterbegin" || resolved.position === "beforeend"
				? resolved.anchor
				: resolved.anchor.parentElement,
		);

		if (this.ready && !this.awarenessComponent) {
			this.mountAwarenessComponent();
		}
	}

	private isAtResolvedAnchor(resolved: AwarenessAnchor): boolean {
		if (!this.awarenessElement) return false;

		switch (resolved.position) {
			case "afterbegin":
				return resolved.anchor.firstElementChild === this.awarenessElement;
			case "beforeend":
				return resolved.anchor.lastElementChild === this.awarenessElement;
			case "beforebegin":
				return (
					resolved.anchor.previousElementSibling === this.awarenessElement
				);
			case "afterend":
				return resolved.anchor.nextElementSibling === this.awarenessElement;
		}
	}

	private setPositioningParent(parent: HTMLElement | null) {
		if (parent === this.positioningParent) {
			if (
				parent &&
				!parent.classList.contains("user-awareness-positioning-parent")
			) {
				parent.classList.add("user-awareness-positioning-parent");
				this.addedPositioningClass = true;
			}
			return;
		}

		if (this.positioningParent && this.addedPositioningClass) {
			this.positioningParent.classList.remove(
				"user-awareness-positioning-parent",
			);
		}

		this.positioningParent = parent ?? undefined;
		this.addedPositioningClass = false;
		if (
			this.positioningParent &&
			!this.positioningParent.classList.contains(
				"user-awareness-positioning-parent",
			)
		) {
			this.positioningParent.classList.add(
				"user-awareness-positioning-parent",
			);
			this.addedPositioningClass = true;
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
					getEditor: this.host.getEditor,
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

		this.setPositioningParent(null);
		this.host = null as any;
	}
}
