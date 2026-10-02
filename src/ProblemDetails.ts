/** RFC 9457 fields understood by the client. Unknown extensions are ignored. */
export interface ProblemDetails {
	type: string;
	title?: string;
	detail?: string;
	status?: number;
	instance?: string;
}

/** Parse a known HTTP response body, where RFC members may be omitted. */
export function parseProblemDetails(value: unknown): ProblemDetails | undefined {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const record = value as Record<string, unknown>;
	const type = nonemptyString(record.type);
	const title = nonemptyString(record.title);
	const detail = nonemptyString(record.detail);
	if (!title && !detail) return undefined;
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
	function visit(
		value: unknown,
		depth: number,
		knownProblem = false,
	): ProblemDetails | undefined {
		if (depth > 16) return undefined;
		if (typeof value === "string") {
			try {
				return visit(JSON.parse(value), depth + 1, knownProblem);
			} catch {
				return undefined;
			}
		}
		if (!value || typeof value !== "object" || seen.has(value)) return undefined;
		seen.add(value);
		const record = value as Record<string, unknown>;
		const problem = parseProblemDetails(value);
		// Ordinary errors also carry detail/title/type fields. Outside a parsed
		// HTTP error's problem member, require an HTTP status or an absolute URI.
		if (problem && (
			knownProblem || problem.status !== undefined ||
			(typeof record.type === "string" && /^[a-z][a-z\d+.-]*:/i.test(record.type))
		)) return problem;
		for (const key of ["problem", "cause", "response", "data", "body", "error", "message"]) {
			const nested = visit(record[key], depth + 1, key === "problem");
			if (nested) return nested;
		}
		return undefined;
	}
	return visit(value, 0);
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
