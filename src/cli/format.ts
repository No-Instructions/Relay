import { CliError, type CliFormat, type CliResult } from "./types";

export function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "yes" : "no";
	return String(value);
}

/** Fixed-width text table. Empty rows render as "(none)". */
export function table(columns: string[], rows: unknown[][]): string {
	if (rows.length === 0) return "(none)";
	const text = rows.map((row) => row.map(cell));
	const widths = columns.map((column, i) =>
		Math.max(column.length, ...text.map((row) => (row[i] ?? "").length)),
	);
	const line = (cells: string[]) =>
		cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();
	return [line(columns), ...text.map(line)].join("\n");
}

/** "key: value" lines, skipping undefined values. */
export function kv(entries: [string, unknown][]): string {
	return entries
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}: ${cell(value)}`)
		.join("\n");
}

export function renderOk(result: CliResult, format: CliFormat): string {
	if (format !== "json") return result.text;
	const payload = Array.isArray(result.data)
		? { ok: true, items: result.data }
		: { ok: true, ...result.data };
	return JSON.stringify(payload, null, 2);
}

export function renderError(error: unknown, format: CliFormat): string {
	const cliError =
		error instanceof CliError
			? error
			: new CliError("error", error instanceof Error ? error.message : String(error));
	if (format === "json") {
		return JSON.stringify(
			{ ok: false, code: cliError.code, message: cliError.message, ...cliError.extra },
			null,
			2,
		);
	}
	const lines = [`Error: ${cliError.message}`];
	const candidates = cliError.extra.candidates;
	if (Array.isArray(candidates) && candidates.length > 0) {
		lines.push("Candidates:");
		for (const candidate of candidates) {
			const record = candidate as Record<string, unknown>;
			lines.push(`  ${cell(record.name ?? record.path)}  ${cell(record.guid ?? record.id)}`);
		}
	}
	return lines.join("\n");
}

export function formatOf(params: Record<string, string>): CliFormat {
	return params.format === "json" ? "json" : "text";
}
