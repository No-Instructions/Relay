import type { CliData, CliFlags, Plugin } from "obsidian";
import { CLI_COMMANDS } from "./commands";
import { formatOf, renderError, renderOk } from "./format";
import type { CliCommand, CliContext } from "./types";

const FORMAT_FLAG: CliFlags = {
	format: { value: "text|json", description: "Output format (default: text)" },
};

type CliRegistrar = Pick<Plugin, "registerCliHandler">;

/** A handler never throws: failures come back as an envelope in the chosen format. */
export function cliHandler(command: CliCommand, ctx: CliContext) {
	return async (params: CliData): Promise<string> => {
		const format = formatOf(params);
		try {
			return renderOk(await command.run(params, ctx), format);
		} catch (error) {
			return renderError(error, format);
		}
	};
}

export function registerRelayCli(plugin: CliRegistrar, ctx: CliContext, commands = CLI_COMMANDS): string[] {
	const registered: string[] = [];
	for (const command of commands) {
		plugin.registerCliHandler(
			command.id,
			command.description,
			{ ...(command.flags ?? {}), ...FORMAT_FLAG },
			cliHandler(command, ctx),
		);
		registered.push(command.id);
	}
	return registered;
}
