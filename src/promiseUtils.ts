"use strict";

import { curryLog } from "./debug";
import type { TimeProvider } from "./TimeProvider";

export type PromiseFunction<T> = () => Promise<T>;
export type CheckFunction<T> = () => [boolean, T];
export type LifetimeOperation<T> =
	| Promise<T>
	| ((signal: AbortSignal) => Promise<T>);

export class Lifetime {
	private ended = false;
	private endReason: unknown;
	private controller = new AbortController();
	private endListeners = new Set<(reason: unknown) => void>();

	public get signal(): AbortSignal {
		return this.controller.signal;
	}

	public get active(): boolean {
		return !this.ended;
	}

	public get reason(): unknown {
		return this.endReason;
	}

	public onEnded(listener: (reason: unknown) => void): () => void {
		if (this.ended) {
			listener(this.endReason);
			return () => {};
		}
		this.endListeners.add(listener);
		return () => {
			this.endListeners.delete(listener);
		};
	}

	public guard<T>(operation: LifetimeOperation<T>): Promise<T> {
		if (this.ended) {
			return Promise.reject(this.endReason);
		}

		let promise: Promise<T>;
		try {
			promise =
				typeof operation === "function"
					? operation(this.signal)
					: operation;
		} catch (error) {
			return Promise.reject(error);
		}

		if (this.ended) {
			return Promise.reject(this.endReason);
		}

		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				this.signal.removeEventListener("abort", onEnd);
			};
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};
			const onEnd = () => {
				finish(() => reject(this.endReason));
			};

			this.signal.addEventListener("abort", onEnd, { once: true });
			promise.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	}

	public end(reason: unknown): void {
		if (this.ended) return;
		this.ended = true;
		this.endReason = reason;
		this.controller.abort();
		for (const listener of Array.from(this.endListeners)) {
			listener(reason);
		}
		this.endListeners.clear();
	}
}

export class Dependency<T> {
	private currentPromise: Promise<T> | null = null;
	private promiseFunction: PromiseFunction<T>;
	private checkFunction: CheckFunction<T>;
	private resolver?: (value: T) => void;
	private timeoutId?: number;

	constructor(
		promiseFunction: PromiseFunction<T>,
		checkFunction: CheckFunction<T>,
		private timeProvider: TimeProvider,
	) {
		this.promiseFunction = promiseFunction;
		this.checkFunction = checkFunction;
	}

	private setTimeout(callback: () => void, ms: number): number {
		return this.timeProvider.setTimeout(callback, ms);
	}

	private clearTimeout(timerId: number): void {
		this.timeProvider.clearTimeout(timerId);
	}

	public getPromise(): Promise<T> {
		const [success, result] = this.checkFunction();
		const onSuccess = (result: T) => {
			if (this.currentPromise && this.resolver) {
				const resolve = this.resolver;
				resolve(result);
				if (this.timeoutId) {
					this.clearTimeout(this.timeoutId);
				}
				this.resolver = undefined;
			}
			return this.currentPromise;
		};
		if (success) {
			const promise = onSuccess(result);
			if (promise) return promise;
		}

		if (!this.currentPromise) {
			this.currentPromise = new Promise((resolve, reject) => {
				this.resolver = resolve;
				this.timeoutId = this.setTimeout(() => {
					curryLog("[Promise]", "debug")(
						"Dependency stuck after 3s. Checking.",
						this.promiseFunction.toString(),
					);
					const [success, result] = this.checkFunction();
					if (success) {
						onSuccess(result);
					}
				}, 3000);
				this.promiseFunction().then(
					(result) => {
						if (this.timeoutId) {
							this.clearTimeout(this.timeoutId);
						}
						resolve(result);
					},
					(error) => {
						if (this.timeoutId) {
							this.clearTimeout(this.timeoutId);
						}
						this.currentPromise = null; // Reset on failure
						reject(error);
					},
				);
			});
		}
		return this.currentPromise;
	}

	public destroy(): void {
		if (this.timeoutId) {
			this.clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		this.currentPromise = null;
		this.resolver = undefined;
	}
}

export class SharedPromise<T> {
	private currentPromise: Promise<T> | null = null;
	private promiseFunction: PromiseFunction<T>;
	private timeoutId?: number;

	constructor(
		promiseFunction: PromiseFunction<T>,
		private timeProvider: TimeProvider,
	) {
		this.promiseFunction = promiseFunction;
	}

	private setTimeout(callback: () => void, ms: number): number {
		return this.timeProvider.setTimeout(callback, ms);
	}

	private clearTimeout(timerId: number): void {
		this.timeProvider.clearTimeout(timerId);
	}

	public getPromise(): Promise<T> {
		if (!this.currentPromise) {
			this.currentPromise = new Promise((resolve, reject) => {
				this.timeoutId = this.setTimeout(() => {
					curryLog("[Promise]", "error")(
						"SharedPromise stuck after 3s:",
						this.promiseFunction.toString(),
					);
				}, 3000);
				this.promiseFunction().then(
					(result) => {
						if (this.timeoutId) {
							this.clearTimeout(this.timeoutId);
						}
						this.currentPromise = null;
						resolve(result);
					},
					(error) => {
						if (this.timeoutId) {
							this.clearTimeout(this.timeoutId);
						}
						this.currentPromise = null;
						reject(error);
					},
				);
			});
		}
		return this.currentPromise;
	}

	public destroy(): void {
		if (this.timeoutId) {
			this.clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		this.currentPromise = null;
	}
}

export function withTimeoutWarning<T>(
	promise: Promise<T>,
	timeProvider: TimeProvider,
	...logArgs: any[]
): Promise<T> {
	return new Promise((resolve, reject) => {
		const onTimeout = () => {
			curryLog("[Promise]", "debug")("Promise stuck after 3s:", ...logArgs);
		};
		const timeoutId = timeProvider.setTimeout(onTimeout, 3000);
		const clearWarningTimeout = () => {
			timeProvider.clearTimeout(timeoutId);
		};

		promise.then(
			(result) => {
				clearWarningTimeout();
				resolve(result);
			},
			(error) => {
				clearWarningTimeout();
				reject(error);
			},
		);
	});
}
