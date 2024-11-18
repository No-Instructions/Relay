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

export class SharedPromise<T> {
	private currentPromise: Promise<T> | null = null;
	private promiseFunction: PromiseFunction<T>;
	private checkFunction: CheckFunction<T>;

	constructor(
		promiseFunction: PromiseFunction<T>,
		checkFunction: CheckFunction<T>,
	) {
		this.promiseFunction = promiseFunction;
		this.checkFunction = checkFunction;
	}

	public getPromise(): Promise<T> {
		const [success, result] = this.checkFunction();
		if (success) {
			return Promise.resolve(result);
		}

		if (!this.currentPromise) {
			this.currentPromise = this.promiseFunction().then(
				(result) => {
					this.currentPromise = null; // Reset on success
					return result;
				},
				(error) => {
					this.currentPromise = null; // Reset on failure
					throw error;
				},
			);
		}
		return this.currentPromise;
	}
}
