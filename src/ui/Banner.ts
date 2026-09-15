"use strict";
import { Platform, requireApiVersion, TextFileView } from "obsidian";
import type { CanvasView } from "src/CanvasView";

export type BannerText = string | { short: string; long: string };

interface BannerOptions {
	/** Higher priority owns the view's single banner slot. */
	priority?: number;
	backgroundColor?: string;
	color?: string;
	render?: (container: HTMLElement) => () => void;
}

const slots = new WeakMap<HTMLElement, { candidates: Set<Banner>; active?: Banner }>();

export class Banner {
	view: TextFileView | CanvasView;
	text: BannerText;
	onClick: () => Promise<boolean>;
	private useHeaderButton: boolean;
	private element?: HTMLElement;
	private disposeContent?: () => void;
	private destroyed = false;

	constructor(
		view: TextFileView | CanvasView,
		text: BannerText,
		onClick: () => Promise<boolean>,
		private options: BannerOptions = {},
	) {
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
		let slot = slots.get(container);
		if (!slot) {
			slot = { candidates: new Set() };
			slots.set(container, slot);
		}
		slot.candidates.add(this);
		this.refreshSlot();
		return true;
	}

	private refreshSlot(): void {
		const slot = slots.get(this.view.containerEl);
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

		const bannerBox = leafContentEl.createDiv({ cls: "system3-banner-box" });
		this.element = bannerBox;
		leafContentEl.insertBefore(bannerBox, contentEl);
		leafContentEl.addClass("system3-has-banner");
		const banner = bannerBox.createDiv({ cls: "system3-banner" });
		if (this.options.backgroundColor) banner.style.backgroundColor = this.options.backgroundColor;
		if (this.options.color) banner.style.color = this.options.color;
		if (this.options.render) {
			banner.style.cursor = "default";
			this.disposeContent = this.options.render(banner);
		} else {
			banner.createSpan({ text: this.longText });
			banner.addEventListener("click", () => this.handleClick());
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

		const button = leafContentEl.createEl("button", {
			cls: "view-header-left system3-header-button",
			text: this.shortText,
			attr: { "aria-label": this.longText, tabindex: "0" },
		});
		this.element = button;
		if (this.options.backgroundColor) button.style.backgroundColor = this.options.backgroundColor;
		if (this.options.color) button.style.color = this.options.color;

		button.addEventListener("click", () => this.handleClick());

		viewHeaderLeftElement.insertAdjacentElement("afterend", button);
		return true;
	}

	private hide(): void {
		this.disposeContent?.();
		this.disposeContent = undefined;
		this.element?.remove();
		this.element = undefined;
		const leafContentEl = this.view.containerEl;
		if (!leafContentEl.querySelector(".system3-banner-box")) leafContentEl.removeClass("system3-has-banner");
	}

	destroy() {
		if (this.destroyed) return true;
		this.destroyed = true;
		const slot = slots.get(this.view.containerEl);
		slot?.candidates.delete(this);
		this.refreshSlot();
		if (slot?.candidates.size === 0) slots.delete(this.view.containerEl);
		this.onClick = async () => true;
		return true;
	}
}
