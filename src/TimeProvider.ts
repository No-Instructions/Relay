"use strict";
export class DefaultTimeProvider implements TimeProvider {
	timeouts: number[];
	intervals: number[];

	constructor() {
		this.timeouts = [];
		this.intervals = [];
	}

	now(): number {
		return Date.now();
	}

	setInterval(callback: () => void, ms: number): number {
		const timer = window.setInterval(callback, ms);
		this.intervals.push(timer);
		return timer;
	}

	clearInterval(timerId: number): void {
		window.clearInterval(timerId);
	}

	setTimeout(callback: () => void, ms: number): number {
		const timer = window.setTimeout(() => {
			this.timeouts.remove(timer);
			callback();
		}, ms);
		this.timeouts.push(timer);
		return timer;
	}

	clearTimeout(timerId: number): void {
		window.clearTimeout(timerId);
	}

	destroy(): void {
		for (const timer of this.timeouts) {
			this.clearTimeout(timer);
		}
		this.timeouts = [];
		for (const interval of this.intervals) {
			this.clearInterval(interval);
		}
		this.intervals = [];
	}

	debounce<Args extends unknown[]>(
		func: (...args: Args) => void,
		delay: number = 500,
	): (...args: Args) => void {
		let timer: number | undefined;
		return (...args: Args) => {
			if (timer !== undefined) {
				this.clearTimeout(timer);
			}
			timer = this.setTimeout(() => {
				timer = undefined;
				func(...args);
			}, delay);
		};
	}
}

export interface TimeProvider {
	now: () => number;
	setInterval: (callback: () => void, ms: number) => number;
	clearInterval: (timerId: number) => void;
	setTimeout: (callback: () => void, ms: number) => number;
	clearTimeout: (timerId: number) => void;
	destroy: () => void;
	debounce: <Args extends unknown[]>(
		func: (...args: Args) => void,
		delay: number,
	) => (...args: Args) => void;
}
