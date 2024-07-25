import type { IObservable, Observable } from "./Observable";

export interface Mail<T> {
	sender: T & IObservable<T>;
	recipient: (value: T) => void;
	transactionId: number;
	timestamp: number;
	recipientOrigin?: string;
}

export class PostOffice {
	private static instance: PostOffice;
	private mailboxes: Map<(value: any) => void, Set<IObservable<any>>> =
		new Map();
	private allMailLog: Mail<any>[] = [];
	private deliveredMailLog: Mail<any>[] = [];
	private isDelivering: boolean = false;
	private deliveryInterval: number | null = null;
	private currentTransactionId: number = 0;
	private isInTransaction: boolean = false;

	private constructor(private deliveryWindow: number = 20) {}

	static getInstance(): PostOffice {
		if (!PostOffice.instance) {
			PostOffice.instance = new PostOffice();
			console.warn("postie", this.instance);
		}
		return PostOffice.instance;
	}

	beginTransaction(): void {
		this.isInTransaction = true;
		this.currentTransactionId++;
	}

	commitTransaction(): void {
		this.isInTransaction = false;
		if (!this.isDelivering) {
			this.scheduleDelivery();
		}
	}

	send<T>(
		sender: T & IObservable<T>,
		recipient: (value: T) => void,
		immediate: boolean = false
	): void {
		const mail: Mail<T> = {
			sender,
			recipient,
			transactionId: this.currentTransactionId,
			timestamp: Date.now(),
			recipientOrigin: this.getFunctionOrigin(recipient),
		};
		this.allMailLog.push(mail);

		if (!this.mailboxes.has(recipient)) {
			this.mailboxes.set(recipient, new Set());
		}
		this.mailboxes.get(recipient)!.add(sender);

		if (immediate) {
			this.deliverImmediate(sender, recipient);
		} else if (!this.isInTransaction && !this.isDelivering) {
			this.scheduleDelivery();
		}
	}

	private deliverImmediate<T>(
		sender: T & IObservable<T>,
		recipient: (value: T) => void
	): void {
		recipient(sender);
		this.deliveredMailLog.push({
			sender,
			recipient,
			transactionId: this.currentTransactionId,
			timestamp: Date.now(),
			recipientOrigin: this.getFunctionOrigin(recipient),
		});
	}

	private scheduleDelivery(): void {
		this.isDelivering = true;
		this.deliveryInterval = window.setTimeout(() => {
			this.deliver();
			this.deliveryInterval = null;
			this.isDelivering = false;
			if (this.mailboxes.size > 0 && !this.isInTransaction) {
				this.scheduleDelivery();
			}
		}, this.deliveryWindow);
	}

	private deliver(): void {
		for (const [recipient, senders] of this.mailboxes) {
			for (const sender of senders) {
				recipient(sender);
				console.log("send", sender, recipient);
				this.deliveredMailLog.push({
					sender,
					recipient,
					transactionId: this.currentTransactionId,
					timestamp: Date.now(),
					recipientOrigin: this.getFunctionOrigin(recipient),
				});
			}
			senders.clear();
		}
	}

	getAllMailLog(): Mail<any>[] {
		return [...this.allMailLog];
	}

	getDeliveredMailLog(): Mail<any>[] {
		return [...this.deliveredMailLog];
	}

	prettyPrintAllMailLog(): void {
		console.log("All Mail Log:");
		this.prettyPrintMailLog(this.allMailLog);
	}

	prettyPrintDeliveredMailLog(): void {
		console.log("Delivered Mail Log:");
		this.prettyPrintMailLog(this.deliveredMailLog);
	}

	private prettyPrintMailLog(log: Mail<any>[]): void {
		log.forEach((mail, index) => {
			console.log(`Mail #${index + 1}:`);
			console.log(
				`  Timestamp: ${new Date(mail.timestamp).toISOString()}`
			);
			console.log(`  Transaction ID: ${mail.transactionId}`);
			console.log(
				`  Sender: ${
					mail.sender.observableName || mail.sender.constructor.name
				}`
			);
			console.log(
				`  Recipient: ${mail.recipient.name || "Anonymous function"}`
			);
			console.log(
				`  Recipient Origin: ${mail.recipientOrigin || "Unknown"}`
			);
			console.log("---");
		});
	}

	getFunctionOrigin(func: Function): string {
		// If the function has a name, return it
		if (func.name) {
			return func.name;
		}

		// Get the function's string representation
		const funcString = func.toString();

		// Try to extract a name from the function definition
		const funcMatch = funcString.match(/^(function|class)?\s*([^\s(]*)/);
		if (funcMatch && funcMatch[2]) {
			return funcMatch[2];
		}

		// For anonymous functions, return a portion of their definition
		const maxLength = 200; // Adjust this value to control the length of the returned string
		let definition = funcString
			.replace(/\s+/g, " ") // Replace multiple spaces with a single space
			.slice(0, maxLength);

		if (definition.length === maxLength) {
			definition += "...";
		}

		return `AnonymousFunction(${definition})`;
	}
}
