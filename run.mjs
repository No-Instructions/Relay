#!/usr/bin/env node
// Declarative command runner: the public front door for pluggable commands.
//
//   lint    runs every linter declared in lint.d/ — one JSON entry per
//           linter, { "description", "run" }, named by filename. An entry
//           with "default": false is declared but on demand only: named
//           arguments select entries (`npm run lint obsidian`), and
//           removing the field admits it to the default gate. Public and
//           developer-overlay entries share the directory; .gitignore
//           keeps entries private unless a whitelist line makes one public.
//   deploy  delegates to the developer overlay's scripts/deploy, which owns
//           the target registry (infra/deploy-targets.d/) and its guards.
//
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DOMAINS = {
	lint: { dir: "lint.d", mode: "all", noun: "linter" },
	deploy: { delegate: "scripts/deploy", noun: "target" },
};

const [command, ...args] = process.argv.slice(2);
const domain = DOMAINS[command];
if (!domain) {
	console.error(`usage: node run.mjs <${Object.keys(DOMAINS).join("|")}> [name] [--list]`);
	process.exit(2);
}

if (domain.delegate) {
	if (!existsSync(domain.delegate)) {
		console.error(`${command}: not available in this checkout (${domain.delegate} is part of the developer overlay)`);
		process.exit(1);
	}
	process.exit(
		spawnSync("python3", [domain.delegate, ...args], { stdio: "inherit" }).status ?? 1,
	);
}

const entries = existsSync(domain.dir)
	? readdirSync(domain.dir)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => ({
				name: file.replace(/\.json$/, ""),
				...JSON.parse(readFileSync(`${domain.dir}/${file}`, "utf8")),
			}))
	: [];

if (entries.length === 0) {
	console.error(`${command}: no ${domain.noun}s declared in ${domain.dir}/`);
	process.exit(1);
}

const list = () => {
	const width = Math.max(...entries.map((e) => e.name.length));
	for (const e of entries)
		console.log(
			`  ${e.name.padEnd(width)}  ${e.description ?? ""}${e.default === false ? "  (on demand)" : ""}`.trimEnd(),
		);
};

if (args.includes("--list")) {
	list();
	process.exit(0);
}

const run = (entry) =>
	spawnSync(entry.run, { stdio: "inherit", shell: true }).status ?? 1;

const names = args.filter((a) => !a.startsWith("-"));
for (const name of names) {
	if (!entries.some((e) => e.name === name)) {
		console.error(`${command}: no ${domain.noun} named '${name}' in ${domain.dir}/`);
		process.exit(1);
	}
}
const selected = names.length
	? entries.filter((e) => names.includes(e.name))
	: entries.filter((e) => e.default !== false);
const onDemand = names.length ? [] : entries.filter((e) => e.default === false);

let failed = 0;
for (const entry of selected) {
	console.log(`${command}: ${entry.name}${entry.description ? ` — ${entry.description}` : ""}`);
	const status = run(entry);
	if (status !== 0) {
		failed += 1;
		console.error(`${command}: ${entry.name} failed (exit ${status})`);
	}
}
if (failed) {
	console.error(`${command}: ${failed} of ${selected.length} ${domain.noun}s failed`);
	process.exit(1);
}
console.log(`${command}: ${selected.length} ${domain.noun}${selected.length === 1 ? "" : "s"} passed`);
for (const entry of onDemand)
	console.log(`${command}: ${entry.name} is on demand — npm run ${command} ${entry.name}`);
