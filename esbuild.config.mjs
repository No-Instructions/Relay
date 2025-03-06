import esbuild from "esbuild";
import process from "process";
import esbuildSvelte from "esbuild-svelte";
import sveltePreprocess from "svelte-preprocess";
import builtins from "builtin-modules";
import { execSync } from "child_process";
import chokidar from "chokidar";
import path from "path";
import fs, { mkdirSync } from "fs";

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const gitTag = execSync("git describe --tags --always", {
	encoding: "utf8",
}).trim();

const staging = process.argv[2] === "staging";
const watch = process.argv[2] === "watch" || staging;
const debug = process.argv[2] === "debug" || watch || staging;
const out = process.argv[3] || ".";
const tld = staging ? "dev" : "md";

const apiUrl = `https://api.system3.${tld}`;
const authUrl = `https://auth.system3.${tld}`;
const healthUrl = `${apiUrl}/health?version=${gitTag}`;
console.log("git tag:", gitTag);
console.log("health URL", healthUrl);

const NotifyPlugin = {
	name: "on-end",
	setup(build) {
		build.onEnd((result) => {
			if (result.errors.length > 0) execSync(`notify-send "Build Failed"`);
		});
	},
};

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	plugins: [
		esbuildSvelte({
			compilerOptions: { css: true },
			preprocess: sveltePreprocess(),
		}),
		NotifyPlugin,
	],
	target: "es2018",
	minify: !debug,
	logLevel: "info",
	sourcemap: debug ? "inline" : false,
	define: {
		BUILD_TYPE: debug ? '"debug"' : '"prod"',
		GIT_TAG: `"${gitTag}"`,
		HEALTH_URL: `"${healthUrl}"`,
		API_URL: `"${apiUrl}"`,
		AUTH_URL: `"${authUrl}"`,
		REPOSITORY: `"No-Instructions/Relay"`,
	},
	treeShaking: true,
	outfile: out + "/main.js",
});

const copyFile = (src, dest) => {
	if (src === dest) {
		return;
	}
	fs.copyFileSync(src, dest);
	console.log(`Copied ${src} to ${dest}`);
};

const watchAndMove = (fnames, mapping) => {
	// only usable on top level directory
	const watcher = chokidar.watch(fnames, {
		ignored: /(^|[\/\\])\../, // ignore dotfiles
		persistent: true,
	});

	watcher.on("change", (filePath) => {
		const destName = mapping[filePath] || filePath;
		const destPath = path.join(out, path.basename(destName));
		copyFile(filePath, destPath);
	});
};

const mapping = debug ? { "manifest-beta.json": "manifest.json" } : {};
const manifest = debug ? "manifest-beta.json" : "manifest.json";
const files = ["styles.css", manifest];

const updateManifest = (manifest) => {
	const manifestPath = path.join(out, path.basename("manifest.json"));
	const raw_manifest = fs.readFileSync(manifestPath);
	const parsed = JSON.parse(raw_manifest);
	parsed.version = gitTag;
	const new_manifest = JSON.stringify(parsed, null, 2);
	console.log(`Set ${manifest} version to ${gitTag}`);
	fs.writeFileSync(manifestPath, new_manifest);
};

const move = (fnames, mapping) => {
	// only usable on top level directory
	mkdirSync(out, { recursive: true });
	for (const fname of fnames) {
		const destName = mapping[fname] || fname;
		const destPath = path.join(out, path.basename(destName));
		copyFile(fname, destPath);
	}
};

if (watch) {
	await context.watch();
	move(files, mapping);
	updateManifest();
	watchAndMove(files, mapping);
} else {
	await context.rebuild();
	move(files, mapping);
	updateManifest();
	process.exit(0);
}
