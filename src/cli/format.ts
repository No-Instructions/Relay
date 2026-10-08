import { CliError, type CliFormat, type CliResult } from "./types";

export function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "symbol") return String(value);
	return JSON.stringify(value) ?? "";
}

/** Key/value table, skipping undefined values. */
export function kv(entries: [string, unknown][]): string {
	return table(["key", "value"], entries.filter(([, value]) => value !== undefined));
}

export function markdownText(value: unknown): string {
	return cell(value).replace(/[\\`*_[\]|<>~]/g, "\\$&").replace(/\r\n?|\n/g, " ");
}

/** Tab-delimited rows; escaped control characters preserve cell boundaries. */
export function table(columns: string[], rows: unknown[][]): string {
	const escape = (value: unknown) => cell(value)
		.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
	const line = (row: unknown[]) => columns.map((_, i) => escape(row[i])).join("\t");
	return [line(columns), ...rows.map(line)].join("\n");
}

type OutputContext = { vault: { name: string; path: string | null }; command: string };

export function vaultText(vault: OutputContext["vault"]): string {
	return `Vault: ${markdownText(vault.name)}`;
}

export function renderOk(result: CliResult, format: CliFormat, context?: OutputContext): string {
	if (format !== "json") {
		if (!context) return result.text;
		const vault = result.markdown ? `**Vault:** ${markdownText(context.vault.name)}` : vaultText(context.vault);
		return `${vault}\n\n${result.text}`;
	}
	const payload = Array.isArray(result.data)
		? { ok: true, items: result.data }
		: { ok: true, ...result.data };
	return JSON.stringify({ ...payload, ...context }, null, 2);
}

export function renderError(error: unknown, format: CliFormat, context?: OutputContext, helpCommand?: string): string {
	const cliError =
		error instanceof CliError
			? error
			: new CliError("error", error instanceof Error ? error.message : String(error));
	if (format === "json") {
		return JSON.stringify(
			{ ok: false, code: cliError.code, message: cliError.message, ...cliError.extra, ...context, helpCommand },
			null,
			2,
		);
	}
	const lines = [`Error: ${cliError.message}`];
	if (context) lines.push(vaultText(context.vault));
	for (const [label, alternatives] of [["Candidates:", cliError.extra.candidates], ["Did you mean:", cliError.extra.suggestions]]) {
		if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
		lines.push(label as string);
		for (const alternative of alternatives) {
			if (typeof alternative === "string") lines.push(`  ${alternative}`);
			else {
				const record = alternative as Record<string, unknown>;
				const id = record.guid ?? record.id;
				lines.push(`  ${cell(record.name ?? record.path)}${id === undefined ? "" : `  ${cell(id)}`}`);
			}
		}
	}
	if (helpCommand) lines.push(`Help: ${helpCommand}`);
	return lines.join("\n");
}
