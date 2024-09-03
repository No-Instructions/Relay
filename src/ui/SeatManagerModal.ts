import { App, Modal, Setting } from "obsidian";
import { Plus, Minus } from "lucide-svelte";

export class SeatManagerModal extends Modal {
	currentQuantity: number;
	selectedQuantity: number;
	priceEl!: HTMLElement;
	actionButtonEl!: HTMLButtonElement;

	onSubmit: (quantity: number) => void;

	constructor(
		app: App,
		currentQuantity: number,
		onSubmit: (quantity: number) => void,
	) {
		super(app);
		this.currentQuantity = currentQuantity;
		this.selectedQuantity = currentQuantity;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Manage Seats" });

		new Setting(contentEl)
			.setName("Number of Seats")
			.addButton((btn) =>
				btn.setIcon("minus").onClick(() => {
					if (this.selectedQuantity > 3) {
						this.selectedQuantity--;
						this.updateDisplay();
					}
				}),
			)
			.addText((text) =>
				text.setValue(this.selectedQuantity.toString()).onChange((value) => {
					const newValue = parseInt(value, 10);
					if (!isNaN(newValue) && newValue >= 3) {
						this.selectedQuantity = newValue;
						this.updateDisplay();
					}
				}),
			)
			.addButton((btn) =>
				btn.setIcon("plus").onClick(() => {
					this.selectedQuantity++;
					this.updateDisplay();
				}),
			);

		this.actionButtonEl = contentEl.createEl("button", {
			text: this.getActionText(),
			cls: "mod-cta",
		});
		this.actionButtonEl.addEventListener("click", () => {
			this.onSubmit(this.selectedQuantity);
			this.close();
		});

		this.priceEl = contentEl.createEl("p");
		this.updateDisplay();
	}

	updateDisplay() {
		const price = this.calculatePrice(this.selectedQuantity);
		this.priceEl.textContent = `Price: $${price} per month`;
		this.actionButtonEl.textContent = this.getActionText();
	}

	getActionText(): string {
		if (this.selectedQuantity === 3) return "Cancel";
		if (this.selectedQuantity === this.currentQuantity) return "Manage";
		return this.selectedQuantity > this.currentQuantity
			? "Upgrade"
			: "Downgrade";
	}

	calculatePrice(quantity: number): number {
		return Math.max(0, quantity - 3) * 2;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
