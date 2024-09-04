// Adapted from https://github.com/pocketbase/js-sdk/blob/master/src/stores/LocalAuthStore.ts
//
// The MIT License (MIT) Copyright (c) 2022 - present, Gani Georgiev
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { BaseAuthStore, type AuthModel } from "pocketbase";

export class LocalAuthStore extends BaseAuthStore {
	private storageFallback: { [key: string]: any } = {};
	private storageKey: string;

	constructor(storageKey = "pocketbase_auth") {
		super();

		this.storageKey = storageKey;
		this._bindStorageEvent();
	}

	/**
	 * @inheritdoc
	 */
	get token(): string {
		const data = this._storageGet(this.storageKey) || {};

		return data.token || "";
	}

	/**
	 * @inheritdoc
	 */
	get model(): AuthModel {
		const data = this._storageGet(this.storageKey) || {};

		return data.model || null;
	}

	/**
	 * @inheritdoc
	 */
	save(token: string, model?: AuthModel) {
		this._storageSet(this.storageKey, {
			token: token,
			model: model,
		});

		super.save(token, model);
	}

	/**
	 * @inheritdoc
	 */
	clear() {
		this._storageRemove(this.storageKey);

		super.clear();
	}

	destroy() {
		this._unbindStorageEvent();
	}

	// ---------------------------------------------------------------
	// Internal helpers:
	// ---------------------------------------------------------------

	/**
	 * Retrieves `key` from the browser's local storage
	 * (or runtime/memory if local storage is undefined).
	 */
	private _storageGet(key: string): any {
		if (typeof window !== "undefined" && window?.localStorage) {
			const rawValue = window.localStorage.getItem(key) || "";
			try {
				return JSON.parse(rawValue);
			} catch (e) {
				// not a json
				return rawValue;
			}
		}

		// fallback
		return this.storageFallback[key];
	}

	/**
	 * Stores a new data in the browser's local storage
	 * (or runtime/memory if local storage is undefined).
	 */
	private _storageSet(key: string, value: any) {
		if (typeof window !== "undefined" && window?.localStorage) {
			// store in local storage
			let normalizedVal = value;
			if (typeof value !== "string") {
				normalizedVal = JSON.stringify(value);
			}
			window.localStorage.setItem(key, normalizedVal);
		} else {
			// store in fallback
			this.storageFallback[key] = value;
		}
	}

	/**
	 * Removes `key` from the browser's local storage and the runtime/memory.
	 */
	private _storageRemove(key: string) {
		// delete from local storage
		if (typeof window !== "undefined" && window?.localStorage) {
			window.localStorage?.removeItem(key);
		}

		// delete from fallback
		delete this.storageFallback[key];
	}

	private _storageChangeHandler = (e: StorageEvent) => {
		if (e.key != this.storageKey) {
			return;
		}

		const data = this._storageGet(this.storageKey) || {};

		super.save(data.token || "", data.model || null);
	};

	/**
	 * Updates the current store state on localStorage change.
	 */
	private _bindStorageEvent() {
		if (
			typeof window === "undefined" ||
			!window?.localStorage ||
			!window.addEventListener
		) {
			return () => {};
		}
		window.addEventListener("storage", this._storageChangeHandler);
	}

	private _unbindStorageEvent() {
		if (
			typeof window === "undefined" ||
			!window?.localStorage ||
			!window.addEventListener
		) {
			return () => {};
		}
		window.removeEventListener("storage", this._storageChangeHandler);
	}
}
