"use strict";

import { DestroyedError } from "./DestroyedError";

/**
 * Wrap an object in a lifecycle guard: every property access after the
 * owner reports destroyed throws a DestroyedError naming the owner and the
 * member touched, instead of surfacing as a null-field crash deep inside a
 * method. Holders of the guarded reference fail fast and legibly.
 *
 * Method reads are bound to the target so calls execute against the real
 * object without re-entering the guard on every internal property access;
 * bindings are cached per property and refreshed if the underlying method
 * is replaced.
 */
export function createProtectionProxy<T extends object>(
	target: T,
	isDestroyed: () => boolean,
	describe: () => string,
): T {
	const bindings = new Map<
		PropertyKey,
		{ original: unknown; bound: unknown }
	>();
	return new Proxy(target, {
		get(target, prop) {
			if (isDestroyed()) {
				throw new DestroyedError(describe(), String(prop));
			}
			const value = (target as Record<PropertyKey, unknown>)[prop];
			if (typeof value === "function") {
				const cached = bindings.get(prop);
				if (cached && cached.original === value) {
					return cached.bound;
				}
				const bound = value.bind(target);
				bindings.set(prop, { original: value, bound });
				return bound;
			}
			return value;
		},
	});
}
