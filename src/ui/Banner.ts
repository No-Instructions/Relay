"use strict";
import { TextFileView } from "obsidian";
import type { CanvasView } from "src/CanvasView";

export class Banner {
	view: TextFileView | CanvasView;
	text: string;
	onClick: () => Promise<boolean>;

	constructor(
		view: TextFileView | CanvasView,
		text: string,
		onClick: () => Promise<boolean>,
	) {
		this.view = view;
		this.text = text;
		this.onClick = onClick;
		this.display();
	}

	display() {
		if (!this.view) return true;
		const leafContentEl = this.view.containerEl;
		const contentEl = this.view.containerEl.querySelector(".view-content");

		if (!leafContentEl) {
			return;
		}

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
			span.setText(this.text);
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

	destroy() {
		const leafContentEl = this.view.containerEl;
		if (!leafContentEl) {
			return;
		}
		const bannerBox = leafContentEl.querySelector(".system3-banner-box");
		if (bannerBox) {
			bannerBox.replaceChildren();
		}
		this.onClick = async () => true;
		return true;
	}
}
