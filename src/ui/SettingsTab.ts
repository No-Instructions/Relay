import { App, ButtonComponent, PluginSettingTab } from "obsidian";
import Live from "src/main";

export class LiveSettingsTab extends PluginSettingTab {
	plugin: Live;
	constructor(app: App, plugin: Live) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Obsidian Live" });
		containerEl.createEl("h3", { text: "Login" });

		if (this.plugin.loginManager.hasUser) {
			containerEl.createEl("p", {
				text: `Logged in as ${this.plugin.loginManager.user.name}`,
			});
			new ButtonComponent(containerEl)
				.setButtonText("Logout")
				.onClick((e) =>
					(() => {
						this.plugin.loginManager.logout();
						this.display();
					})()
				);
		} else {
			new ButtonComponent(containerEl)
				.setButtonText("Login with Google")
				.onClick((e) =>
					(async () => {
						await this.plugin.loginManager.login();
						this.display();
					})()
				);
		}

		//		const formEl = stripeEl.createEl("form");
		//		formEl.addClass("stripe");
		//		formEl.setAttr("id", "payment-form");
		//
		//		const paymentEl = formEl.createDiv();
		//		paymentEl.setAttr("id", "payment-element");
		//
		const subscribe = this.plugin.loginManager.sm.subscription?.subscribe;
		if (subscribe) {
			const stripeEl = containerEl.createDiv();
			stripeEl.createEl("h2", { text: "Manage Subscription" });
			stripeEl.addClass("stripe");

			const linkEl = stripeEl.createEl("a", {
				href: subscribe,
			});
			const buttonEl = linkEl.createEl("button");

			const buttonText = buttonEl.createSpan();
			buttonText.setAttr("id", "button-text");
			buttonText.innerHTML = "Subscribe";
		}
		const cancel = this.plugin.loginManager.sm.subscription?.cancel;
		if (cancel) {
			const stripeEl = containerEl.createDiv();
			stripeEl.createEl("h2", { text: "Manage Subscription" });
			stripeEl.addClass("stripe");

			const linkEl = stripeEl.createEl("a", {
				href: cancel,
			});
			const buttonEl = linkEl.createEl("button");

			const buttonText = buttonEl.createSpan();
			buttonText.setAttr("id", "button-text");
			buttonText.innerHTML = "Cancel Subscription";
		}

		//
		//		const spinnerEl = buttonEl.createDiv();
		//		spinnerEl.addClasses(["spinner", "hidden"]);
		//
		//
		//		//buttonEl.appendChild(spinnerEl);
		//		//buttonEl.appendChild(buttonText);
		//
		//		const paymentMessage = formEl.createDiv();
		//		paymentMessage.addClass("hidden");
		//
		//formEl.appendChild(paymentEl);
		//formEl.appendChild(buttonEl);
		//formEl.appendChild(paymentMessage);

		//stripeEl.appendChild(formEl);
		//containerEl.appendChild(stripeEl);
	}
}
