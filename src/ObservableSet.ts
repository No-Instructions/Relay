"use strict";
export class ObservableSet<T> {
	private set: Set<T>;
	private listeners: Set<() => void>;

	constructor() {
		this.set = new Set();
		this.listeners = new Set();
	}

	protected notifyListeners(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	on(listener: () => void): void {
		this.listeners.add(listener);
	}

	off(listener: () => void): void {
		this.listeners.delete(listener);
	}

	add(item: T): ObservableSet<T> {
		this.set.add(item);
		this.notifyListeners();
		return this;
	}

	delete(item: T): boolean {
		const result = this.set.delete(item);
		if (result) {
			this.notifyListeners();
		}
		return result;
	}

	clear(): void {
		this.set.clear();
		this.notifyListeners();
	}

	has(item: T): boolean {
		return this.set.has(item);
	}

	items(): T[] {
		return [...this.set];
	}

	get size(): number {
		return this.set.size;
	}

	forEach(callbackfn: (value: T, index: number, array: T[]) => void): void {
		this.items().forEach(callbackfn);
	}

	find(predicate: (value: T) => boolean): T | undefined {
		return this.items().find(predicate);
	}

	some(predicate: (item: T) => boolean): boolean {
		for (const item of this.set) {
			if (predicate(item)) {
				return true;
			}
		}
		return false;
	}
}
