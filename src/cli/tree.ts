import type { CliData, CliFlags } from "obsidian";
import { CliError, type CliCommand, type CliOption, type CliRegisteredCommand } from "./types";
import { suggest } from "./suggest";

export const GLOBAL_OPTIONS: Record<string, CliOption> = {
	help: { description: "Show help (-h)" },
	json: { description: "JSON output; check ok for success" },
	format: { value: "text|json", choices: ["text", "json"], description: "Output format (default: text)" },
	copy: { description: "Copy output to clipboard" },
	quiet: { description: "Hide vault header" },
};

export function flattenCommands(command: CliCommand, parent = ""): CliRegisteredCommand[] {
	const id = parent ? `${parent}:${command.name}` : command.name;
	return [...(command.register === false ? [] : [{ ...command, id }]), ...(command.commands ?? []).flatMap((child) => flattenCommands(child, id))];
}

/** Obsidian parses argv. Relay validates the resulting option dictionary. */
export function validateOptions(command: CliRegisteredCommand, raw: CliData): CliData {
	const definitions = { ...GLOBAL_OPTIONS, ...command.options };
	const params: CliData = {};
	for (const [key, value] of Object.entries(raw)) {
		if (command.assignment && !key.startsWith("-")) {
			if (params.key !== undefined) throw new CliError("conflicting_options", "Set one flag at a time");
			if (!command.assignment.choices.includes(value)) {
				throw new CliError("invalid_value", `${key} must be ${command.assignment.value}`);
			}
			params.key = key;
			params.value = value;
			continue;
		}
		if (command.argument && !key.startsWith("-") && value === "true") {
			const name = command.argument;
			if (name in params) throw new CliError("duplicate_option", `Give one ${name}: a positional argument or --${name}`);
			if (!key.trim()) throw new CliError("missing_value", `${name} must not be empty`);
			params[name] = key.trim();
			continue;
		}
		const name = key === "-h" ? "help" : key.startsWith("--") ? key.slice(2) : "";
		if (!Object.prototype.hasOwnProperty.call(definitions, name)) {
			const message = key === "--vault" || key === "vault"
				? 'Select a vault before the command: obsidian vault="My Vault" ' + command.id
				: `Unknown option or argument: ${key}. ` + (command.assignment
					? `Set a flag with <key>=${command.assignment.value}.`
					: "Use colon-separated commands and --option=value.");
			const suggestions = suggest(key.replace(/^-+/, ""), Object.keys(definitions), (name) => [name])
				.map((name) => `--${name}`);
			throw new CliError("unknown_option", message, suggestions.length ? { suggestions } : {});
		}
		const option = definitions[name];
		if (name in params) throw new CliError("duplicate_option", command.argument === name
			? `Give one ${name}: a positional argument or --${name}` : `Give --${name} only once`);
		if (!option.value) {
			if (value !== "true" && value !== "false") {
				throw new CliError("invalid_value", `--${name} accepts true or false, got "${value}"`);
			}
		} else {
			// The host represents a bare switch and the literal value true alike.
			if (value === "true") throw new CliError("missing_value", `--${name} needs a value: --${name}=${option.value}. The host reserves literal true for bare switches.`);
			const normalized = option.preserveWhitespace ? value : value.trim();
			if (!option.allowEmpty && normalized === "") throw new CliError("missing_value", `--${name} needs a non-empty value`);
			if (option.choices && !option.choices.includes(normalized)) {
				throw new CliError("invalid_value", `--${name} must be one of ${option.choices.join(", ")}, got "${value}"`);
			}
		}
		params[name] = option.preserveWhitespace ? value : value.trim();
	}
	if (params.json === "true" && params.format === "text") {
		throw new CliError("conflicting_options", "--json conflicts with --format=text");
	}
	if (params.help !== "true" && command.run) {
		if (command.assignment && params.key === undefined) {
			throw new CliError("missing_assignment", `Give <key>=${command.assignment.value}`);
		}
		for (const [name, option] of Object.entries(command.options ?? {})) {
			if (option.required && !(name in params)) throw new CliError("missing_option", `Missing required option: --${name}=${option.value ?? "true"}`);
		}
	}
	return params;
}

/** Relay owns required checks so a leaf's --help needs no operation arguments. */
export function nativeFlags(command: CliRegisteredCommand): CliFlags {
	return Object.fromEntries([
		...(command.assignment ? [["<key>", { value: command.assignment.value, description: command.assignment.description, required: false }]] : []),
		...Object.entries({ ...command.options, ...GLOBAL_OPTIONS }).map(([name, option]) => [
			`--${name}`, {
				value: option.value,
				description: option.description + (option.required ? " (required)" : "") + (command.argument === name ? "; or positional" : ""),
				required: false,
			},
		]),
		["-h", { description: "Print help", required: false }],
	]);
}

export function commandHelp(command: CliRegisteredCommand): string {
	const lines = [
		"Usage: obsidian [vault=<name|id>] <command> [argument] [--option=value] [--flag]",
		"",
		"Global options:",
		...Object.entries(GLOBAL_OPTIONS).map(([name, option]) => optionLine(name, option)),
		"",
	];
	const separator = command.id.lastIndexOf(":");
	for (const entry of flattenCommands(command, separator === -1 ? "" : command.id.slice(0, separator))) {
		lines.push(`${entry.id}  ${entry.description}`);
		for (const [name, option] of Object.entries(entry.options ?? {})) lines.push(optionLine(name, option, entry.argument === name));
		if (entry.assignment) lines.push(`  <key>=${entry.assignment.value}  ${entry.assignment.description} (required)`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function optionLine(name: string, option: CliOption, positional = false): string {
	return `  ${positional ? option.value + " | " : ""}--${name}${option.value ? "=" + option.value : ""}  ${option.description}${option.required ? " (required)" : ""}`;
}
