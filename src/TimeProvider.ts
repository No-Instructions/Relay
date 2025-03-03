"use strict";
export class DefaultTimeProvider implements TimeProvider {
	timeouts: number[];
	intervals: number[];

	constructor() {
		this.timeouts = [];
		this.intervals = [];
	}

	getTime(): number {
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

	debounce<T extends (...args: any[]) => void>(
		func: T,
		delay: number = 500,
	): (...args: Parameters<T>) => void {
		let timer: ReturnType<typeof setTimeout>;
		return (...args: Parameters<T>) => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				func(...args);
			}, delay);
		};
	}
}

export interface TimeProvider {
	getTime: () => number;
	setInterval: (callback: () => void, ms: number) => number;
	clearInterval: (timerId: number) => void;
	setTimeout: (callback: () => void, ms: number) => number;
	clearTimeout: (timerId: number) => void;
	destroy: () => void;
	debounce: <T extends (...args: any[]) => void>(
		func: T,
		delay: number,
	) => (...args: Parameters<T>) => void;
}
