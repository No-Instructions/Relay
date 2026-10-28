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
	/** Label a desktop action button instead of making the whole banner clickable. */
	actionLabel?: string;
	/** CSS class namespace; a string in the options' place sets it alone. */
	namespace?: string;
}

type BannerSlot = { candidates: Set<Banner>; active?: Banner };
// A note view has one banner position, regardless of which feature owns it.
const slots = new WeakMap<HTMLElement, BannerSlot>();

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
		this.namespace = typeof options === "string" ? options : (options.namespace ?? "system3");
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

		const bannerBox = leafContentEl.createDiv({ cls: `${this.namespace}-banner-box` });
		this.element = bannerBox;
		leafContentEl.insertBefore(bannerBox, contentEl);
		leafContentEl.addClass("system3-has-banner");
		const banner = bannerBox.createDiv({ cls: `${this.namespace}-banner` });
		if (this.options.backgroundColor) banner.style.backgroundColor = this.options.backgroundColor;
		if (this.options.color) banner.style.color = this.options.color;
		if (this.options.render) {
			banner.addClass("relay-banner-rendered");
			this.disposeContent = this.options.render(banner);
		} else {
			const context = typeof this.text === "string" ? undefined : this.text.context;
			const content = banner.createSpan({ text: context ? "" : this.longText });
			if (context) {
				const label = content.createSpan({ cls: "relay-banner-context" });
				setIcon(label.createSpan({ cls: "relay-banner-context-icon" }), context.icon);
				label.createSpan({ text: context.name });
				content.createSpan({ text: ` ${this.longText}` });
			}
			if (this.onClick && this.options.actionLabel) {
				content.createSpan({ text: " " });
				const action = content.createEl("button", {
					cls: "relay-banner-action",
					text: this.options.actionLabel,
					attr: { type: "button" },
				});
				action.addEventListener("click", () => this.handleClick());
			} else if (this.onClick) {
				banner.addEventListener("click", () => this.handleClick());
			}
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

		const context = typeof this.text === "string" ? undefined : this.text.context;
		const description = context ? `${context.name} ${this.longText}` : this.longText;
		const button = leafContentEl.createEl(this.onClick ? "button" : "span", {
			cls: `view-header-left ${this.namespace}-header-${this.onClick ? "button" : "label"}`,
			text: this.shortText,
			attr: this.onClick ? {
				"aria-label": this.options.actionLabel ? `${this.shortText}: ${description}` : description,
				tabindex: "0",
				type: "button",
			} : {},
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
		this.view.containerEl.removeClass("system3-has-banner");
	}

	destroy() {
		if (this.destroyed) return true;
		this.destroyed = true;
		const slot = slots.get(this.view.containerEl);
		slot?.candidates.delete(this);
		this.refreshSlot();
		if (slot?.candidates.size === 0) slots.delete(this.view.containerEl);
		this.onClick = undefined;
		return true;
	}
}
