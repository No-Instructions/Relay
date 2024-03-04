"use strict";
import { LiveView } from "../LiveViews";

export class ConnectionStatusIcon {
	view: LiveView;
	iconContainer: Element | null;

	constructor(view: LiveView) {
		this.view = view;
		this.iconContainer = null;
	}

	ensureIconContainer() {
		if (this.iconContainer) return true;

		const viewActionsElement =
			this.view.view.containerEl.querySelector(".view-actions");

		let iconContainer = viewActionsElement?.querySelector(
			".connection-status-icon"
		);
		if (!viewActionsElement) {
			return;
		}
		if (!iconContainer) {
			iconContainer = document.createElement("span");
			iconContainer.classList.add("connection-status-icon");
			iconContainer.innerHTML = '<span class="unknown">●</span>';

			viewActionsElement.insertBefore(
				iconContainer,
				viewActionsElement.firstChild
			);
		}

		iconContainer.addEventListener("click", () =>
			this.view.toggleConnection()
		);
		this.iconContainer = iconContainer;
		return true;
	}

	destroy() {
		const viewActionsElement =
			this.view.view.containerEl.querySelector(".view-actions");

		const iconContainer = viewActionsElement?.querySelector(
			".connection-status-icon"
		);
		if (iconContainer) {
			iconContainer.innerHTML = "";
		}
		return true;
	}

	setState(guid: string, status: string) {
		if (!this.ensureIconContainer()) return;
		if (!this.iconContainer) return;
		this.iconContainer.innerHTML = `<span class="connection-status-icon-${status}">●</span>`;
	}

	connect(guid: string) {
		this.setState(guid, "connected");
	}

	disconnect() {
		this.setState("", "disconnected");
	}
}
