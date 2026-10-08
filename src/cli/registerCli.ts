import type { CliData, CliFlags, CliHandler } from "obsidian";
import { CLI_COMMANDS } from "./commands";
import { renderError, renderOk } from "./format";
import { commandHelp, nativeFlags, validateOptions } from "./tree";
import { CliError, type CliContext, type CliRegisteredCommand } from "./types";

type CliRegistrar = {
	registerCliHandler(command: string, description: string, flags: CliFlags | null, handler: CliHandler): void;
};

export function cliHandler(command: CliRegisteredCommand, ctx: CliContext): CliHandler {
	return async (raw: CliData): Promise<string> => {
		const context = { vault: { name: ctx.vault.name, path: ctx.vault.path }, command: command.id };
		const format = [raw.json, raw["--json"]].includes("true") ||
			[raw.format, raw["--format"]].some((value) => value?.trim() === "json") ? "json" : "text";
		const outputContext = format === "text" && (raw.quiet ?? raw["--quiet"]) === "true" ? undefined : context;
		try {
			const params = validateOptions(command, raw);
			if (params.help === "true" || !command.run) {
				const help = commandHelp(command);
				return renderOk({ data: { help }, text: help }, format, outputContext);
			}
			return renderOk(await command.run(params, ctx), format, outputContext);
		} catch (error) {
			const output = renderError(error, format, outputContext, `obsidian help ${command.id}`);
			if (format === "json") return output;
			throw new CliError(error instanceof CliError ? error.code : "error", output.replace(/^Error: /, ""));
		}
	};
}

export function registerRelayCli(plugin: CliRegistrar, ctx: CliContext, commands = CLI_COMMANDS): string[] {
	for (const command of commands) {
		plugin.registerCliHandler(command.id, command.description, nativeFlags(command), cliHandler(command, ctx));
	}
	return commands.map((command) => command.id);
}
