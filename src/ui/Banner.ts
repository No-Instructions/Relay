"use strict";
import { Platform, requireApiVersion, setIcon, TextFileView } from "obsidian";
import type { CanvasView } from "src/CanvasView";

export type BannerText = string | {
	short: string;
	long: string;
	context?: { name: string; icon: string };
};

export class Banner {
	view: TextFileView | CanvasView;
	text: BannerText;
	onClick?: () => Promise<boolean>;
	private useHeaderButton: boolean;

	constructor(
		view: TextFileView | CanvasView,
		text: BannerText,
		onClick?: () => Promise<boolean>,
		private namespace = "system3",
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
		if (!this.view) return true;
		const leafContentEl = this.view.containerEl;

		if (!leafContentEl) {
			return;
		}

		if (this.useHeaderButton) {
			return this.displayHeaderItem();
		}

		const contentEl = this.view.containerEl.querySelector(".view-content");

		// container to enable easy removal of the banner
		let bannerBox = leafContentEl.querySelector(`.${this.namespace}-banner-box`);
		if (!bannerBox) {
			bannerBox = leafContentEl.createDiv({ cls: `${this.namespace}-banner-box` });
			leafContentEl.insertBefore(bannerBox, contentEl);
			leafContentEl.addClass("system3-has-banner");
		}

		let banner = leafContentEl.querySelector(`.${this.namespace}-banner`);
		if (!banner) {
			banner = bannerBox.createDiv({ cls: `${this.namespace}-banner` });
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

	private displayHeaderItem() {
		const leafContentEl = this.view.containerEl;
		const viewHeaderLeftElement =
			leafContentEl.querySelector(".view-header-left");

		if (!viewHeaderLeftElement) {
			return;
		}

		leafContentEl.querySelector(`.${this.namespace}-header-button, .${this.namespace}-header-label`)?.remove();

		const item = leafContentEl.createEl(this.onClick ? "button" : "span", {
			cls: `view-header-left ${this.namespace}-header-${this.onClick ? "button" : "label"}`,
			text: this.shortText,
			attr: this.onClick ? { "aria-label": this.longText, tabindex: "0" } : {},
		});

		if (this.onClick) item.addEventListener("click", () => this.handleClick());

		viewHeaderLeftElement.insertAdjacentElement("afterend", item);
		return true;
	}

	destroy() {
		const leafContentEl = this.view.containerEl;
		if (!leafContentEl) {
			return;
		}

		if (this.useHeaderButton) {
			leafContentEl.querySelector(`.${this.namespace}-header-button, .${this.namespace}-header-label`)?.remove();
		} else {
			const bannerBox = leafContentEl.querySelector(`.${this.namespace}-banner-box`);
			if (bannerBox) {
				bannerBox.replaceChildren();
			}
		}
		this.onClick = undefined;
		return true;
	}
}
