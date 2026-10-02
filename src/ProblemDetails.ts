/** RFC 9457 fields understood by the client. Unknown extensions are ignored. */
export interface ProblemDetails {
	type: string;
	title?: string;
	detail?: string;
	status?: number;
	instance?: string;
}

export function parseProblemDetails(value: unknown): ProblemDetails | undefined {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const type = nonemptyString(record.type);
	const title = nonemptyString(record.title);
	const detail = nonemptyString(record.detail);
	if (!type && !title && !detail) return undefined;
	return {
		type: type ?? "about:blank",
		title,
		detail,
		status:
			typeof record.status === "number" && Number.isInteger(record.status) &&
			record.status >= 100 && record.status <= 599
				? record.status
				: undefined,
		instance: nonemptyString(record.instance),
	};
}

/** Preserve server copy through the error wrappers used by sync and transports. */
export function findProblemDetails(value: unknown): ProblemDetails | undefined {
	const seen = new Set<object>();
	function visit(value: unknown, depth: number): ProblemDetails | undefined {
		if (depth > 16) return undefined;
		if (typeof value === "string") {
			try {
				return visit(JSON.parse(value), depth + 1);
			} catch {
				return undefined;
			}
		}
		const problem = parseProblemDetails(value);
		if (problem) return problem;
		if (!value || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		const record = value as Record<string, unknown>;
		for (const key of ["problem", "cause", "response", "data", "body", "error", "message"]) {
			const nested = visit(record[key], depth + 1);
			if (nested) return nested;
		}
		return undefined;
	}
	return visit(value, 0);
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
