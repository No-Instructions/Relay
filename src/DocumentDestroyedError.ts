"use strict";

import { DestroyedError } from "./DestroyedError";

export class DocumentDestroyedError extends DestroyedError {
	constructor(
		public readonly guid: string,
		public readonly path?: string,
	) {
		super("Document", path ? `${path} (${guid})` : guid);
		this.name = "DocumentDestroyedError";
	}
}

export function isDocumentDestroyedError(
	error: unknown,
): error is DocumentDestroyedError {
	return error instanceof DocumentDestroyedError;
}
