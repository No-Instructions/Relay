"use strict";
import { Platform, requireApiVersion, TextFileView } from "obsidian";
import type { CanvasView } from "src/CanvasView";

export type BannerText = string | { short: string; long: string };

export class Banner {
	view: TextFileView | CanvasView;
	text: BannerText;
	onClick: () => Promise<boolean>;
	private useHeaderButton: boolean;

	constructor(
		view: TextFileView | CanvasView,
		text: BannerText,
		onClick: () => Promise<boolean>,
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

	display() {
		if (!this.view) return true;
		const leafContentEl = this.view.containerEl;

		if (!leafContentEl) {
			return;
		}

		if (this.useHeaderButton) {
			return this.displayHeaderButton();
		}

		const contentEl = this.view.containerEl.querySelector(".view-content");

		// container to enable easy removal of the banner
		let bannerBox = leafContentEl.querySelector(".system3-banner-box");
		if (!bannerBox) {
			bannerBox = document.createElement("div");
			bannerBox.classList.add("system3-banner-box");
			leafContentEl.insertBefore(bannerBox, contentEl);
		}

		let banner = leafContentEl.querySelector(".system3-banner");
		if (!banner) {
			banner = document.createElement("div");
			banner.classList.add("system3-banner");
			const span = banner.createSpan();
			span.setText(this.longText);
			banner.appendChild(span);
			bannerBox.appendChild(banner);
			const onClick = async () => {
				const destroy = await this.onClick();
				if (destroy) {
					this.destroy();
				}
			};
			banner.addEventListener("click", onClick);
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

		// Remove existing button if any
		leafContentEl.querySelector(".system3-header-button")?.remove();

		const button = document.createElement("button");
		button.className = "view-header-left system3-header-button";
		button.textContent = this.shortText;
		button.setAttribute("aria-label", this.longText);
		button.setAttribute("tabindex", "0");

		button.addEventListener("click", async () => {
			const destroy = await this.onClick();
			if (destroy) {
				this.destroy();
			}
		});

		viewHeaderLeftElement.insertAdjacentElement("afterend", button);
		return true;
	}

	destroy() {
		const leafContentEl = this.view.containerEl;
		if (!leafContentEl) {
			return;
		}

		if (this.useHeaderButton) {
			leafContentEl.querySelector(".system3-header-button")?.remove();
		} else {
			const bannerBox = leafContentEl.querySelector(".system3-banner-box");
			if (bannerBox) {
				bannerBox.replaceChildren();
			}
		}
		this.onClick = async () => true;
		return true;
	}
}
