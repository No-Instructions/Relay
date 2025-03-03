import type { TimeProvider } from "src/TimeProvider";

export class MockTimeProvider implements TimeProvider {
	private currentTime: number;
	private timers: Array<{
		id: number;
		callback: () => void;
		triggerTime: number;
	}> = [];
	private nextTimerId = 0;

	constructor() {
		this.currentTime = Date.now();
	}

	getTime(): number {
		return this.currentTime;
	}

	setTime(newTime: number): void {
		const diff = (newTime - this.currentTime) / 1000;
		console.log(`setting time to ${newTime} (+${diff}s)`);
		this.currentTime = newTime;
		this.checkTimers();
	}

	//setInterval(callback: () => void, ms: number): NodeJS.Timer {
	//	const triggerTime = this.currentTime + ms;
	//	const timerId = setTimeout(() => callback(), ms);
	//	this.timers.push({ id: timerId, callback, triggerTime });
	//	return timerId;
	//}

	setInterval(callback: () => void, ms: number): number {
		return this.setTimeout(callback, ms, true);
	}

	clearInterval(timerId: number): void {
		const id = <number>(<unknown>timerId);
		this.timers = this.timers.filter((timer) => timer.id !== id);
	}

	setTimeout(callback: () => void, ms: number, isInterval = false): number {
		const triggerTime = this.currentTime + ms;
		const timerId = this.nextTimerId++;
		const timer = { id: timerId, callback, triggerTime };
		this.timers.push(timer);
		if (isInterval) {
			// If it's an interval, we immediately schedule the next execution
			const index = this.timers.length - 1;
			this.timers[index].callback = () => {
				callback();
				this.setTimeout(callback, ms, true); // Reschedule next execution
			};
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return <any>timerId;
	}

	debounce<T extends (...args: any[]) => void>(
		func: T,
		delay: number = 500,
	): (...args: Parameters<T>) => void {
		let timerId: number | undefined;

		return (...args: Parameters<T>) => {
			if (timerId !== undefined) {
				this.clearTimeout(timerId);
			}

			timerId = this.setTimeout(() => {
				func(...args);
			}, delay);
		};
	}

	destroy() {
		this.timers.forEach((timer) => clearTimeout(timer.id));
		this.timers = [];
	}

	//clearInterval(timerId: TimerID): void {
	//	this.timers = this.timers.filter((timer) => timer.id !== timerId);
	//	clearTimeout(timerId);
	//}

	//setTimeout(callback: () => void, ms: number): TimerID {
	//	const triggerTime = this.currentTime + ms;
	//	const timerId = { id: this.nextTimerId++ }; // Use an object as the ID to ensure uniqueness and avoid conflicts
	//	this.timers.push({ id: timerId, callback, triggerTime });
	//	return timerId;
	//}

	clearTimeout(timerId: number): void {
		const id = <number>(<unknown>timerId);
		this.timers = this.timers.filter((timer) => timer.id !== id);
	}

	private checkTimers(): void {
		console.log(this.timers);
		this.timers.forEach((timer) => {
			if (this.currentTime >= timer.triggerTime) {
				console.log("timer triggered");
				timer.callback();
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const id = <any>timer.id;
				this.clearInterval(id);
			}
		});
	}
}
