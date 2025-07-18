"use strict";

import { DefaultTimeProvider, type TimeProvider } from "../TimeProvider";
import { RelayInstances, curryLog } from "../debug";
import type { IObservable } from "./Observable";

export interface Mail<T> {
	sender: T & IObservable<T>;
	recipient: (value: T) => void;
	transactionId: number;
	timestamp: number;
	recipientOrigin?: string;
}

export class PostOffice {
	private static _destroyed: boolean = false;
	private static instance: PostOffice;
	private mailboxes: Map<(value: any) => void, Set<IObservable<any>>> =
		new Map();
	private allMailLog: Mail<any>[] = [];
	private deliveredMailLog: Mail<any>[] = [];
	private isDelivering: boolean = false;
	private deliveryInterval: number | null = null;
	private currentTransactionId: number = 0;
	private isInTransaction: boolean = false;

	private constructor(
		private timeProvider: TimeProvider,
		private deliveryWindow: number = 20,
	) {}

	static getInstance(): PostOffice {
		if (this._destroyed) {
			throw new Error("tried to access postie during teardown");
		}
		if (!PostOffice.instance) {
			PostOffice.instance = new PostOffice(new DefaultTimeProvider());
			RelayInstances.set(this.instance, "postie");
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
		immediate: boolean = false,
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
		recipient: (value: T) => void,
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
		this.deliveryInterval = this.timeProvider.setTimeout(() => {
			this.deliver();
			this.deliveryInterval = null;
			this.isDelivering = false;
			if (this.mailboxes.size > 0 && !this.isInTransaction) {
				this.scheduleDelivery();
			}
		}, this.deliveryWindow);
	}

	private deliver(): void {
		const log = curryLog("[postie]", "debug");
		for (const [recipient, senders] of this.mailboxes) {
			for (const sender of senders) {
				recipient(sender);
				log("send", sender.constructor.name, recipient);
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
		const log = curryLog("[postie]", "warn");
		log("All Mail Log:\n" + this.prettyPrintMailLog(this.allMailLog));
	}

	prettyPrintDeliveredMailLog(): void {
		const log = curryLog("[postie]", "warn");
		log(
			"Delivered Mail Log:\n" + this.prettyPrintMailLog(this.deliveredMailLog),
		);
	}

	private prettyPrintMailLog(log: Mail<any>[]): string {
		let text = "";
		const _log = (msg: string) => {
			text += `${msg}\n`;
		};
		log.forEach((mail, index) => {
			_log(`Mail #${index + 1}:`);
			_log(`  Timestamp: ${new Date(mail.timestamp).toISOString()}`);
			_log(`  Transaction ID: ${mail.transactionId}`);
			_log(
				`  Sender: ${
					mail.sender.observableName || mail.sender.constructor.name
				}`,
			);
			_log(`  Recipient: ${mail.recipient.name || "Anonymous function"}`);
			_log(`  Recipient Origin: ${mail.recipientOrigin || "Unknown"}`);
			_log("---");
		});
		return text;
	}

	getFunctionOrigin(func: (...args: any[]) => any): string {
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

	static destroy(): void {
		if (PostOffice.instance) {
			// Clear all mailboxes
			PostOffice.instance.mailboxes = null as any;

			// Clear mail logs
			PostOffice.instance.allMailLog = [];
			PostOffice.instance.deliveredMailLog = [];

			// Cancel any pending delivery
			PostOffice.instance.timeProvider.destroy();
			PostOffice.instance.timeProvider = null as any;

			// Reset flags
			PostOffice.instance.isDelivering = false;
			PostOffice.instance.isInTransaction = false;

			// Reset transaction ID
			PostOffice.instance.currentTransactionId = 0;

			PostOffice._destroyed = true;

			// Remove the singleton instance
			PostOffice.instance = undefined as any;
		}
	}
}
