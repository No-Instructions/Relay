"use strict";

/**
 * PostOffice delivery contracts:
 *
 * - Timers are only best-effort pokes. Chrome can heavily throttle or suspend
 *   timers in hidden tabs, so correctness must not depend on a timeout firing.
 *   Every state-changing input (`send`, `commitTransaction`, the deadline
 *   timer, and external pokes such as `visibilitychange`) feeds `tick()`, which
 *   decides what to do from current state.
 * - The delivery window is a coalescing hint, not a hard clock dependency. A
 *   pending batch may be flushed by the next non-timer input when the deadline
 *   timer is late or absent.
 * - Mail is coalesced by recipient and sender. Multiple notifications from the
 *   same sender to the same recipient within the active window, including
 *   same-sender re-entrant notifications during delivery, intentionally collapse
 *   to one delivery.
 * - Re-entrant notifications for new sender/recipient pairs are drained by
 *   iterating the live mailbox map, so ordinary cascades complete in the same
 *   delivery pass before teardown can cancel their pending mail.
 * - Recipient callbacks must not run synchronously up a caller's `send` stack.
 *   Overdue flushes are scheduled on a microtask; deadline callbacks already run
 *   on a clean stack.
 * - A large or cyclic cascade is delivered in time-budgeted chunks. When a chunk
 *   hits its budget it continues on a macrotask (a MessageChannel message), not
 *   a microtask or timer, so the event loop services timers, paint, and input
 *   between chunks while the queue is still draining.
 */

import { DefaultTimeProvider, type TimeProvider } from "../TimeProvider";
import { RelayInstances, curryLog, isDebugging, metrics } from "../debug";
import type { IObservable } from "./Observable";

// Hoisted so `deliver()` doesn't allocate a logger each pass. curryLog
// stringifies its args and only ever hands a string to console — deliberately
// avoiding raw console.* calls, which would let devtools retain the logged
// objects (senders, errors) and pin plugin state past unload.
const postieDebug = curryLog("[postie]", "debug");
const postieError = curryLog("[postie]", "error");

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
	private deadlineTimer: number | null = null;
	private windowStartedAt: number | null = null;
	private flushScheduled: boolean = false;
	// Persistent MessageChannel used to continue a chunked cascade on a
	// macrotask. Unlike a microtask, a macrotask returns to the event loop
	// between chunks, so timers, paint, and input are serviced while a large
	// cascade is still draining. Created lazily on the first continuation.
	private continuationChannel: MessageChannel | null = null;
	private currentTransactionId: number = 0;
	private isInTransaction: boolean = false;

	private static readonly MAX_DELIVERIES_PER_FLUSH = 10_000;
	// A synchronous delivery chunk yields once it has run for this many wall-clock
	// milliseconds, even if the count cap is not reached. This bounds how long one
	// chunk can hold the main thread before the macrotask continuation lets the
	// event loop run; the count cap remains a backstop.
	private static readonly MAX_FLUSH_MS = 8;
	// Diagnostic ring buffers: bounded so a long, busy session can't grow them
	// without limit (each entry pins its sender observable and recipient closure).
	private static readonly MAX_MAIL_LOG = 1_000;

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

	/**
	 * Returns the singleton if it exists, or null if PostOffice has been
	 * destroyed or was never created. Use this from cleanup/destroy paths
	 * that may run after `PostOffice.destroy()` (e.g. async work registered
	 * with `trackAsyncCleanup`) — calling `getInstance()` post-destroy throws
	 * and creating a fresh singleton mid-teardown leaks the entire mail
	 * graph (each entry's `recipient` closure pins module-level classes).
	 */
	static peekInstance(): PostOffice | null {
		if (this._destroyed) return null;
		return PostOffice.instance ?? null;
	}

	static isDestroyed(): boolean {
		return PostOffice._destroyed;
	}

	beginTransaction(): void {
		this.isInTransaction = true;
		this.currentTransactionId++;
	}

	commitTransaction(): void {
		this.isInTransaction = false;
		this.tick();
	}

	/**
	 * Cancel any pending deliveries for a recipient.
	 * Call this when unsubscribing to prevent stale notifications.
	 */
	cancel(recipient: (value: any) => void): void {
		this.mailboxes.delete(recipient);
		// If that was the last pending mail, retire the coalescing window and any
		// armed deadline so the next batch starts a fresh, full window rather than
		// inheriting this one's leftover time.
		if (!this.hasPendingMail()) {
			this.windowStartedAt = null;
			if (this.deadlineTimer !== null) {
				this.timeProvider.clearTimeout(this.deadlineTimer);
				this.deadlineTimer = null;
			}
		}
	}

	send<T>(
		sender: T & IObservable<T>,
		recipient: (value: T) => void,
		immediate: boolean = false,
	): void {
		// Recording a mail-log entry stringifies the recipient closure
		// (getFunctionOrigin), so it rides the debug flag like the delivery-side
		// logging below rather than running on every send.
		if (isDebugging()) {
			this.recordMail(this.allMailLog, {
				sender,
				recipient,
				transactionId: this.currentTransactionId,
				timestamp: Date.now(),
				recipientOrigin: this.getFunctionOrigin(recipient),
			});
		}

		if (!this.mailboxes.has(recipient)) {
			this.mailboxes.set(recipient, new Set());
		}
		this.mailboxes.get(recipient)!.add(sender);

		if (immediate) {
			this.deliverImmediate(sender, recipient);
			this.mailboxes.get(recipient)?.delete(sender);
			this.deleteMailboxIfEmpty(recipient);
		} else {
			if (this.windowStartedAt === null) {
				this.windowStartedAt = this.timeProvider.now();
			}
			this.tick();
		}
	}

	private deliverImmediate<T>(
		sender: T & IObservable<T>,
		recipient: (value: T) => void,
	): void {
		recipient(sender);
		if (isDebugging()) {
			this.recordMail(this.deliveredMailLog, {
				sender,
				recipient,
				transactionId: this.currentTransactionId,
				timestamp: Date.now(),
				recipientOrigin: this.getFunctionOrigin(recipient),
			});
		}
	}

	/**
	 * Re-evaluate whether a delivery should happen now. Every input — a new
	 * `send`, a `commitTransaction`, the deadline timer firing, or an external
	 * poke such as a visibility change — calls this. The decision is a function
	 * of state (pending mail, whether we're mid-delivery or mid-transaction, and
	 * how long the batch has waited), not of which input fired, so a throttled or
	 * missed timer is just a skipped poke: the next input re-evaluates and
	 * catches up.
	 */
	tick(): void {
		// `tick()` is reachable from external pokes (e.g. a visibilitychange
		// handler), which may fire during teardown after `mailboxes` is nulled.
		if (!this.mailboxes) return;
		if (this.isDelivering || this.flushScheduled || this.isInTransaction) {
			return;
		}
		// A deadline is already pending and the window has not elapsed: nothing
		// to do. This keeps a storm of `send`s O(1) each instead of rescanning.
		if (this.deadlineTimer !== null && !this.isWindowElapsed()) {
			return;
		}
		if (!this.hasPendingMail()) {
			this.windowStartedAt = null;
			return;
		}
		if (this.isWindowElapsed()) {
			// The coalescing window has passed (or the timer was throttled past
			// it). Deliver on a microtask rather than inline, so a delivery
			// triggered from inside a `send` never fires recipients synchronously
			// up the caller's stack.
			this.scheduleFlush();
		} else {
			this.armDeadline();
		}
	}

	private isWindowElapsed(): boolean {
		if (this.windowStartedAt === null) return true;
		const elapsed = this.timeProvider.now() - this.windowStartedAt;
		// A backward wall-clock step (NTP correction, manual change) makes the
		// delta negative; treat that as elapsed so a clock correction can't strand
		// pending mail behind a far-future deadline.
		return elapsed < 0 || elapsed >= this.deliveryWindow;
	}

	private armDeadline(): void {
		if (this.deadlineTimer !== null) return;
		const remaining =
			this.windowStartedAt === null
				? this.deliveryWindow
				: this.windowStartedAt + this.deliveryWindow - this.timeProvider.now();
		// Clamp to [0, deliveryWindow]: a backward clock step can make `remaining`
		// larger than a window, which must never delay delivery beyond it.
		const delay = Math.min(this.deliveryWindow, Math.max(0, remaining));
		this.deadlineTimer = this.timeProvider.setTimeout(() => {
			this.deadlineTimer = null;
			// The timer fires on a clean stack, so deliver directly.
			this.runDelivery();
		}, delay);
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			this.runDelivery();
		});
	}

	// The first flush after a notification uses a microtask (scheduleFlush), so
	// recipients run promptly on a clean stack. A cascade that outgrows one chunk
	// continues here on a macrotask instead: draining back-to-back on microtasks
	// would never return to the event loop, starving timers and paint for the
	// whole cascade. A macrotask yields between chunks, and — unlike a timer — it
	// is not subject to hidden-window throttling.
	private scheduleContinuation(): void {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		this.ensureContinuationChannel();
		if (this.continuationChannel) {
			this.continuationChannel.port2.postMessage(0);
		} else {
			// No MessageChannel in this runtime (a headless/test host). Fall back
			// to a microtask: correctness is unchanged, only the between-chunk
			// yield is lost, which matters solely in a live renderer where
			// MessageChannel is always present.
			queueMicrotask(() => {
				this.flushScheduled = false;
				this.runDelivery();
			});
		}
	}

	private ensureContinuationChannel(): void {
		if (this.continuationChannel || typeof MessageChannel === "undefined") {
			return;
		}
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			this.flushScheduled = false;
			this.runDelivery();
		};
		this.continuationChannel = channel;
	}

	private runDelivery(): void {
		// Guard against firing on a torn-down singleton (a queued microtask or
		// timer can outlive `destroy()`).
		if (!this.mailboxes || this.isDelivering || this.isInTransaction) return;
		if (!this.hasPendingMail()) {
			this.windowStartedAt = null;
			return;
		}
		if (this.deadlineTimer !== null) {
			this.timeProvider.clearTimeout(this.deadlineTimer);
			this.deadlineTimer = null;
		}
		this.isDelivering = true;
		try {
			this.deliver();
		} finally {
			this.isDelivering = false;
			if (this.hasPendingMail()) {
				// A delivery bound was hit — the time budget or the count cap on a
				// large or cyclic cascade (an ordinary re-entrant emit drains in the
				// loop above). Continue on a macrotask, never a timer: delivery must
				// stay independent of timer throttling, and a macrotask returns to
				// the event loop so timers and paint run between chunks. The bounds
				// keep each synchronous chunk finite.
				this.windowStartedAt = this.timeProvider.now();
				this.scheduleContinuation();
			} else {
				this.windowStartedAt = null;
			}
		}
	}

	private deliver(): void {
		const t0 = performance.now();
		metrics.setPostieMailboxDepth(this.mailboxes.size);
		// Counts items processed (delivered or failed), not successes — it bounds
		// total work per pass so a recipient that re-emits on every delivery can't
		// spin the in-place drain forever.
		let processed = 0;
		// Iterate the live map (no snapshot). A notification a recipient emits
		// during its own delivery is appended and drained in this same pass —
		// `Map`/`Set` iteration visits entries added mid-iteration — so it is
		// delivered before control returns to the caller, where a teardown might
		// otherwise unsubscribe the recipient and strip its in-flight mail.
		for (const [recipient, senders] of this.mailboxes) {
			for (const sender of senders) {
				// Yield when the chunk has run its time budget or hit the count cap.
				// The finally in runDelivery re-pokes on a macrotask so the rest of
				// the cascade drains after the event loop has had a turn.
				if (
					processed >= PostOffice.MAX_DELIVERIES_PER_FLUSH ||
					performance.now() - t0 > PostOffice.MAX_FLUSH_MS
				) {
					metrics.observePostieDelivery((performance.now() - t0) / 1000);
					return;
				}
				try {
					recipient(sender);
					metrics.incPostieDeliveries();
					// Per-delivery diagnostics are opt-in behind the debug flag:
					// building a mail-log entry stringifies the recipient closure
					// (getFunctionOrigin) on every delivery, which dominates the cost
					// of a large cascade. The scraped delivery counter above is always
					// kept; the detail rides the flag, as postieDebug already does.
					if (isDebugging()) {
						postieDebug("send", sender.constructor.name, recipient);
						this.recordMail(this.deliveredMailLog, {
							sender,
							recipient,
							transactionId: this.currentTransactionId,
							timestamp: Date.now(),
							recipientOrigin: this.getFunctionOrigin(recipient),
						});
					}
				} catch (cause) {
					// Always count failures: the metric is scraped and survives with
					// the debug flag off. Detail goes through curryLog, which
					// stringifies its args and honors the debug flag — never a raw
					// console.* call, which would let devtools retain the sender and
					// error and pin plugin state past unload.
					metrics.incPostieRecipientErrors();
					postieError("recipient delivery failed", sender.constructor.name, cause);
				}
				senders.delete(sender);
				processed++;
			}
			// Delete only if the set drained empty. A recipient that unsubscribed
			// and was re-notified during this pass has a freshly re-created,
			// non-empty entry that the live iteration must still visit.
			this.deleteMailboxIfEmpty(recipient);
		}
		metrics.observePostieDelivery((performance.now() - t0) / 1000);
	}

	private hasPendingMail(): boolean {
		for (const senders of this.mailboxes.values()) {
			if (senders.size > 0) return true;
		}
		return false;
	}

	private deleteMailboxIfEmpty(recipient: (value: any) => void): void {
		const senders = this.mailboxes.get(recipient);
		if (senders && senders.size === 0) {
			this.mailboxes.delete(recipient);
		}
	}

	private recordMail(logArray: Mail<any>[], mail: Mail<any>): void {
		logArray.push(mail);
		// Trim in batches (drop to the cap only after growing to 2x) so the hot
		// path stays amortized O(1) rather than O(n) on every push.
		if (logArray.length > PostOffice.MAX_MAIL_LOG * 2) {
			logArray.splice(0, logArray.length - PostOffice.MAX_MAIL_LOG);
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
		// Always mark destroyed even if no instance was lazily created this
		// cycle — otherwise subscribers that fire from async work post-disable
		// would call getInstance() and silently create a fresh singleton (no
		// teardown wired up), accumulating mail that pins the entire module.
		PostOffice._destroyed = true;
		if (PostOffice.instance) {
			// Clear all mailboxes
			PostOffice.instance.mailboxes = null as any;

			// Clear mail logs
			PostOffice.instance.allMailLog = [];
			PostOffice.instance.deliveredMailLog = [];

			// Cancel any pending delivery
			PostOffice.instance.timeProvider.destroy();
			PostOffice.instance.timeProvider = null as any;

			// Tear down the continuation port so a queued macrotask cannot fire on
			// the destroyed singleton and the port stops keeping a headless event
			// loop alive.
			if (PostOffice.instance.continuationChannel) {
				PostOffice.instance.continuationChannel.port1.onmessage = null;
				PostOffice.instance.continuationChannel.port1.close();
				PostOffice.instance.continuationChannel = null;
			}

			// Reset flags
			PostOffice.instance.isDelivering = false;
			PostOffice.instance.isInTransaction = false;
			PostOffice.instance.deadlineTimer = null;
			PostOffice.instance.windowStartedAt = null;
			PostOffice.instance.flushScheduled = false;

			// Reset transaction ID
			PostOffice.instance.currentTransactionId = 0;

			PostOffice._destroyed = true;

			// Remove the singleton instance
			PostOffice.instance = undefined as any;
		}
	}

	/**
	 * Reset PostOffice for testing with a custom TimeProvider.
	 * This clears any existing instance and allows a new one to be created.
	 */
	static _resetForTesting(timeProvider?: TimeProvider): void {
		if (PostOffice.instance) {
			PostOffice.instance.timeProvider?.destroy();
			if (PostOffice.instance.continuationChannel) {
				PostOffice.instance.continuationChannel.port1.onmessage = null;
				PostOffice.instance.continuationChannel.port1.close();
				PostOffice.instance.continuationChannel = null;
			}
		}
		PostOffice._destroyed = false;
		PostOffice.instance = undefined as any;
		if (timeProvider) {
			PostOffice.instance = new PostOffice(timeProvider);
			RelayInstances.set(PostOffice.instance, "postie");
		}
	}
}
