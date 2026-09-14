/** Host-independent command metadata, normalized inputs, and results. */
export type CliData = Record<string, string>;

export type CliFormat = "text" | "json";

/** A failure with a stable machine-readable code. */
export class CliError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly extra: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "CliError";
	}
}

export interface CliResult {
	/** Machine payload. Objects merge under `ok: true`; arrays become `items`. */
	data: Record<string, unknown> | unknown[];
	/** Human rendering for `format=text`. */
	text: string;
	/** Markdown output uses a compact vault heading. */
	markdown?: boolean;
}

export interface Command<Context> {
	/** Runtime capability needed by this command and its children. */
	requires?: "server" | "vault";
	name: string;
	description: string;
	/** Structural namespaces can contribute a path without registering a handler. */
	register?: boolean;
	options?: Record<string, CliOption>;
	/** A bare argument can supply this option instead of --option=value. */
	argument?: string;
	assignment?: { value: string; choices: readonly string[]; description: string };
	commands?: Command<Context>[];
	run?(params: CliData, ctx: Context): Promise<CliResult> | CliResult;
}

/** One definition drives native registration, validation, and help. */
export interface CliOption {
	description: string;
	value?: string;
	required?: boolean;
	choices?: readonly string[];
	allowEmpty?: boolean;
	preserveWhitespace?: boolean;
}
