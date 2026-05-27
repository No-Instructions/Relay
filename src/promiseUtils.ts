"use strict";

import { curryLog } from "./debug";
import type { TimeProvider } from "./TimeProvider";

export type PromiseFunction<T> = () => Promise<T>;
export type CheckFunction<T> = () => [boolean, T];

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
