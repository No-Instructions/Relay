"use strict";
import { MarkdownView } from "obsidian";

export class Banner {
	view: MarkdownView;
	text: string;
	onClick: () => Promise<boolean>;

	constructor(
		view: MarkdownView,
		text: string,
		onClick: () => Promise<boolean>
	) {
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
		const bannerBox = leafContentEl.querySelector(".bannerBox");
		if (bannerBox) {
			bannerBox.innerHTML = "";
		}
		return true;
	}
}
