"use strict";

import { curryLog } from "./debug";

export class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
		// Fix for extending built-in classes in TypeScript
		Object.setPrototypeOf(this, TimeoutError.prototype);
	}
}

export function promiseWithTimeout<T>(
	name: string,
	promise: Promise<T>,
	ms: number,
): Promise<T> {
	let timeoutId: number;
	const start = performance.now();
	const timeout = new Promise<T>((_, reject) => {
		timeoutId = window.setTimeout(() => {
			curryLog("[Promise]", "error")(`[${name}] Timeout on promise`, promise);
			const end = performance.now();
			reject(new TimeoutError(`[${name}]: Timeout after ${end - start} ms`));
		}, ms);
	});

	return Promise.race([promise, timeout]).finally(() => {
		clearTimeout(timeoutId);
	});
}

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
	) {
		this.promiseFunction = promiseFunction;
		this.checkFunction = checkFunction;
	}

	public getPromise(): Promise<T> {
		const [success, result] = this.checkFunction();
		const onSuccess = (result: T) => {
			if (this.currentPromise && this.resolver) {
				const resolve = this.resolver;
				resolve(result);
				if (this.timeoutId) {
					clearTimeout(this.timeoutId);
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
				this.timeoutId = window.setTimeout(() => {
					curryLog("[Promise]", "error")(
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
							clearTimeout(this.timeoutId);
						}
						resolve(result);
					},
					(error) => {
						if (this.timeoutId) {
							clearTimeout(this.timeoutId);
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
			clearTimeout(this.timeoutId);
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

	constructor(promiseFunction: PromiseFunction<T>) {
		this.promiseFunction = promiseFunction;
	}

	public getPromise(): Promise<T> {
		if (!this.currentPromise) {
			this.currentPromise = new Promise((resolve, reject) => {
				this.timeoutId = window.setTimeout(() => {
					curryLog("[Promise]", "error")(
						"SharedPromise stuck after 3s:",
						this.promiseFunction.toString(),
					);
				}, 3000);
				this.promiseFunction().then(
					(result) => {
						if (this.timeoutId) {
							clearTimeout(this.timeoutId);
						}
						this.currentPromise = null;
						resolve(result);
					},
					(error) => {
						if (this.timeoutId) {
							clearTimeout(this.timeoutId);
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
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		this.currentPromise = null;
	}
}
