/**
 * Type declarations for yjs's Y.Text.
 *
 * The package's generated typings omit Y.Text's own `toString()`, so
 * TypeScript resolves `ytext.toString()` to `Object.prototype.toString`
 * and type-aware lint rules read the plain-text read of a Y.Text as
 * producing "[object Object]". The runtime method exists and returns the
 * text's string contents; declare it so the read is type-visible.
 */

export {};

declare module "yjs/dist/src/types/YText" {
	interface YText {
		toString(): string;
	}
}
