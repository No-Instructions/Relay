"use strict";

export class DefaultTimeProvider implements TimeProvider {
	all: number[];

	constructor() {
		this.all = [];
	}

	getTime(): number {
		return Date.now();
	}

	setInterval(callback: () => void, ms: number): number {
		const timer = window.setInterval(callback, ms);
		this.all.push(timer);
		return timer;
	}

	clearInterval(timerId: number): void {
		window.clearInterval(timerId);
	}

	destroy(): void {
		for (const timer of this.all) {
			this.clearInterval(timer);
		}
		this.all = [];
	}
}

export interface TimeProvider {
	getTime: () => number;
	setInterval: (callback: () => void, ms: number) => number;
	clearInterval: (timerId: number) => void;
	destroy: () => void;
}
