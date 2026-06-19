"use strict";

export class DestroyedError extends Error {
	constructor(
		public readonly owner: string,
		public readonly detail?: string,
	) {
		super(detail ? `${owner} was destroyed: ${detail}` : `${owner} was destroyed`);
		this.name = "DestroyedError";
	}
}

export function isDestroyedError(error: unknown): error is DestroyedError {
	return error instanceof DestroyedError;
}
