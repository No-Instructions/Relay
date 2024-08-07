"use strict";

import { curryLog } from "./debug"

export function promiseWithTimeout<T>(
	promise: Promise<T>,
	ms: number
): Promise<T> {
	let timeoutId: number;
	const timeout = new Promise<T>((_, reject) => {
		timeoutId = window.setTimeout(() => {
			try {
				throw new Error("Timeout");
			} catch (error) {
				curryLog("[Promise]", "error")("Timeout on promise", promise);
			}
			reject("Timeout after " + ms + " ms");
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
		checkFunction: CheckFunction<T>
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
				}
			);
		}
		return this.currentPromise;
	}
}
