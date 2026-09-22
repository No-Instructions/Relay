"use strict";
import { Platform, requireApiVersion, setIcon, TextFileView } from "obsidian";
import type { CanvasView } from "src/CanvasView";

export type BannerText = string | { short: string; long: string; context?: { name: string; icon: string } };

interface BannerOptions {
	/** Higher priority owns the view's single banner slot. */
	priority?: number;
	backgroundColor?: string;
	color?: string;
	render?: (container: HTMLElement) => () => void;
}

type BannerSlot = { candidates: Set<Banner>; active?: Banner };
const slots = new WeakMap<HTMLElement, Map<string, BannerSlot>>();

export class Banner {
	view: TextFileView | CanvasView;
	text: BannerText;
	onClick?: () => Promise<boolean>;
	private options: BannerOptions;
	private namespace: string;
	private useHeaderButton: boolean;
	private element?: HTMLElement;
	private disposeContent?: () => void;
	private destroyed = false;

	constructor(
		view: TextFileView | CanvasView,
		text: BannerText,
		onClick?: () => Promise<boolean>,
		options: BannerOptions | string = {},
	) {
		this.options = typeof options === "string" ? {} : options;
		this.namespace = typeof options === "string" ? options : "system3";
		this.view = view;
		this.text = text;
		this.onClick = onClick;
		// Use header button approach on mobile for Obsidian >=1.11.0 to avoid banner positioning issues
		this.useHeaderButton = Platform.isMobile && requireApiVersion("1.11.0");
		this.display();
	}

	private get shortText(): string {
		return typeof this.text === "string" ? this.text : this.text.short;
	}

	private get longText(): string {
		return typeof this.text === "string" ? this.text : this.text.long;
	}

	private handleClick(): void {
		if (!this.onClick) return;
		void this.onClick()
			.then((destroy) => {
				if (destroy) {
					this.destroy();
				}
			})
			.catch((error: unknown) => {
				console.error("Banner click failed", error);
			});
	}

	display() {
		if (!this.view || this.destroyed) return true;
		const container = this.view.containerEl;
		if (!container) return;
		let namespaces = slots.get(container);
		if (!namespaces) {
			namespaces = new Map();
			slots.set(container, namespaces);
		}
		let slot = namespaces.get(this.namespace);
		if (!slot) {
			slot = { candidates: new Set() };
			namespaces.set(this.namespace, slot);
		}
		slot.candidates.add(this);
		this.refreshSlot();
		return true;
	}

	private refreshSlot(): void {
		const slot = slots.get(this.view.containerEl)?.get(this.namespace);
		if (!slot) return;
		let next: Banner | undefined;
		for (const candidate of slot.candidates) {
			if (!next || (candidate.options.priority ?? 2) >= (next.options.priority ?? 2)) next = candidate;
		}
		if (next === slot.active) {
			if (next && !next.element) next.show();
			return;
		}
		slot.active?.hide();
		slot.active = next;
		next?.show();
	}

	private show() {
		const leafContentEl = this.view.containerEl;

		if (!leafContentEl) {
			return;
		}

		if (this.useHeaderButton) {
			return this.displayHeaderButton();
		}

		const contentEl = this.view.containerEl.querySelector(".view-content");

		const bannerBox = leafContentEl.createDiv({ cls: `${this.namespace}-banner-box` });
		this.element = bannerBox;
		leafContentEl.insertBefore(bannerBox, contentEl);
		leafContentEl.addClass("system3-has-banner");
		const banner = bannerBox.createDiv({ cls: `${this.namespace}-banner` });
		if (this.options.backgroundColor) banner.style.backgroundColor = this.options.backgroundColor;
		if (this.options.color) banner.style.color = this.options.color;
		if (this.options.render) {
			banner.style.cursor = "default";
			this.disposeContent = this.options.render(banner);
		} else {
			const context = typeof this.text === "string" ? undefined : this.text.context;
			if (context) {
				const content = banner.createSpan();
				const label = content.createSpan({ cls: "relay-banner-context" });
				setIcon(label.createSpan({ cls: "relay-banner-context-icon" }), context.icon);
				label.createSpan({ text: context.name });
				content.createSpan({ text: ` ${this.longText}` });
			} else {
				banner.createSpan({ text: this.longText });
			}
			if (this.onClick) banner.addEventListener("click", () => this.handleClick());
		}
		return true;
	}

	private displayHeaderButton() {
		const leafContentEl = this.view.containerEl;
		const viewHeaderLeftElement =
			leafContentEl.querySelector(".view-header-left");

		if (!viewHeaderLeftElement) {
			return;
		}

		const button = leafContentEl.createEl(this.onClick ? "button" : "span", {
			cls: `view-header-left ${this.namespace}-header-${this.onClick ? "button" : "label"}`,
			text: this.shortText,
			attr: this.onClick ? { "aria-label": this.longText, tabindex: "0" } : {},
		});
		this.element = button;
		if (this.options.backgroundColor) button.style.backgroundColor = this.options.backgroundColor;
		if (this.options.color) button.style.color = this.options.color;

		if (this.onClick) button.addEventListener("click", () => this.handleClick());

		viewHeaderLeftElement.insertAdjacentElement("afterend", button);
		return true;
	}

	private hide(): void {
		this.disposeContent?.();
		this.disposeContent = undefined;
		this.element?.remove();
		this.element = undefined;
		const leafContentEl = this.view.containerEl;
		const hasBanner = [...(slots.get(leafContentEl)?.values() ?? [])].some(slot =>
			slot.active?.element && !slot.active.useHeaderButton);
		if (!hasBanner) leafContentEl.removeClass("system3-has-banner");
	}

	destroy() {
		if (this.destroyed) return true;
		this.destroyed = true;
		const slot = slots.get(this.view.containerEl)?.get(this.namespace);
		slot?.candidates.delete(this);
		this.refreshSlot();
		const namespaces = slots.get(this.view.containerEl);
		if (slot?.candidates.size === 0) namespaces?.delete(this.namespace);
		if (namespaces?.size === 0) slots.delete(this.view.containerEl);
		this.onClick = undefined;
		return true;
	}
}
