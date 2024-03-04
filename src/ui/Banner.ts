"use strict";
import { MarkdownView } from "obsidian";

export class Banner {
	view: MarkdownView;
	text: string;
	onClick: () => void;

	constructor(view: MarkdownView, text: string, onClick: () => void) {
		this.view = view;
		this.text = text;
		this.onClick = onClick;
		this.display();
	}

	display() {
		const leafContentEl = this.view.containerEl;
		const contentEl = this.view.containerEl.querySelector(".view-content");

		if (!leafContentEl) {
			return;
		}

		// container to enable easy removal of the banner
		let bannerBox = leafContentEl.querySelector(".bannerBox");
		if (!bannerBox) {
			bannerBox = document.createElement("div");
			bannerBox.classList.add("bannerBox");
			leafContentEl.insertBefore(bannerBox, contentEl);
		}

		let banner = leafContentEl.querySelector(".banner");
		if (!banner) {
			banner = document.createElement("div");
			banner.classList.add("banner");
			banner.innerHTML = `<span>${this.text}</span>`;
			bannerBox.appendChild(banner);
			banner.addEventListener("click", this.onClick);
			banner.addEventListener("click", () => {
				this.destroy();
			});
		}
		return true;
	}

	destroy() {
		const leafContentEl = this.view.containerEl;
		if (!leafContentEl) {
			return;
		}
		const bannerBox = leafContentEl.querySelector(".bannerBox");
		if (bannerBox) {
			bannerBox.innerHTML = "";
		}
		return true;
	}
}
