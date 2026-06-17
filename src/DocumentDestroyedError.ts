"use strict";

export class DocumentDestroyedError extends Error {
	constructor(
		public readonly guid: string,
		public readonly path?: string,
	) {
		super(
			path
				? `Document was destroyed: ${path} (${guid})`
				: `Document was destroyed: ${guid}`,
		);
		this.name = "DocumentDestroyedError";
	}
}

export function isDocumentDestroyedError(
	error: unknown,
): error is DocumentDestroyedError {
	return error instanceof DocumentDestroyedError;
}
