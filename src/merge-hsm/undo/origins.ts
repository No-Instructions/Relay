/**
 * Origin constants and serialization for OpCapture persistence.
 *
 * Symbols used as Y.js transaction origins cannot be stored in IndexedDB
 * directly. These helpers convert between runtime Symbols and persistable
 * strings using Symbol.for() / Symbol.keyFor().
 */

/** Origin used when ingesting disk edits into localDoc. */
export const DISK_ORIGIN = Symbol.for("relay:disk");

/**
 * Serialize a transaction origin for IndexedDB storage.
 * Returns the global symbol key (via Symbol.keyFor) for registered symbols,
 * the string itself for string origins, or null for unserializable origins.
 */
export function serializeOrigin(origin: any): string | null {
	if (origin == null) return null;
	if (typeof origin === "symbol") return Symbol.keyFor(origin) ?? null;
	return typeof origin === "string" ? origin : String(origin);
}

/**
 * Deserialize a persisted origin string back to a Symbol.
 * All persisted origins are restored as global symbols via Symbol.for().
 */
export function deserializeOrigin(s: string | null): any {
	if (s == null) return null;
	return Symbol.for(s);
}
