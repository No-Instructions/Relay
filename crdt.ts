import blessed from "blessed";
import { Doc } from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { SyncStore, type Meta } from "./src/SyncStore";

if (process.argv.length !== 3) {
	console.error(
		"Usage: node --loader ts-node/esm debug-crdt.mts <debug-url-payload>",
	);
	process.exit(1);
}

type ClientToken = {
	/** The bare URL of the WebSocket endpoint to connect to. The `doc` string will be appended to this. */
	url: string;

	/** A unique identifier for the document that the token connects to. */
	docId: string;

	token: string;

	expiryTime?: number;
};

function base64ToString(input: string) {
	if (typeof window !== "undefined" && window.atob) {
		// Browser
		return window.atob(input);
	} else if (typeof Buffer !== "undefined") {
		// Node.js
		return Buffer.from(input, "base64").toString();
	} else {
		throw new Error("Unable to decode from Base64");
	}
}

function decodeClientToken(token: string): ClientToken {
	let base64 = token.replace("-", "+").replace("_", "/");
	while (base64.length % 4) {
		base64 += "=";
	}
	const jsonString = base64ToString(base64);
	return JSON.parse(jsonString);
}

const payload = process.argv[2];
const clientToken = decodeClientToken(payload);

// Create screen
const terminalScreen = blessed.screen({
	smartCSR: true,
	title: "CRDT Debug Monitor",
});

// Create layout boxes
const layout = blessed.layout({
	parent: terminalScreen,
	width: "100%",
	height: "100%",
	layout: "grid",
	rows: 2,
	cols: 1,
});

const stateBox = blessed.box({
	parent: layout,
	label: "CRDT State",
	border: "line",
	padding: 1,
	height: "60%",
	scrollable: true,
	alwaysScroll: true,
	tags: true,
	style: {
		label: {
			fg: "white",
		},
	},
});

const syncBox = blessed.box({
	parent: layout,
	label: "Sync Store",
	border: "line",
	padding: 1,
	height: "40%",
	scrollable: true,
	alwaysScroll: true,
	tags: true,
	style: {
		label: {
			fg: "white",
		},
	},
});

// Setup document and provider
const ydoc = new Doc();
const syncStore = new SyncStore(ydoc);

const provider = new YSweetProvider(clientToken.url, clientToken.docId, ydoc, {
	connect: true,
	params: { token: clientToken.token },
});

// Helper to format data for display
function formatValue(value: unknown, depth = 0): string {
	const indent = "  ".repeat(depth);

	if (value === null || value === undefined) {
		return "{null}";
	}

	if (typeof value === "object") {
		if (value instanceof Map) {
			const mapEntries = Array.from(value.entries())
				.map(([k, v]) => `${indent}  ${k}: ${formatValue(v, depth + 1)}`)
				.join("\n");
			return `{\n${mapEntries}\n${indent}}`;
		}

		if (value !== null) {
			const objEntries = Object.entries(value)
				.map(([k, v]) => `${indent}  ${k}: ${formatValue(v, depth + 1)}`)
				.join("\n");
			return `{\n${objEntries}\n${indent}}`;
		}
	}

	return String(value);
}

// Update functions
function updateState() {
	const state = {
		docs: Object.fromEntries(ydoc.share.entries()),
		peers: provider.awareness.getStates().size,
		synced: provider.synced,
	};

	stateBox.setContent(formatValue(state));
}

function updateSyncStore() {
	const files: Array<string> = [];
	syncStore.forEach((meta: Meta, path: string) => {
		files.push(`${path}: ${JSON.stringify(meta, null, 2)}`);
	});

	syncBox.setContent(files.join("\n"));
}

// Event handlers
provider.on("sync", () => {
	updateState();
	updateSyncStore();
	terminalScreen.render();
});

provider.on("status", () => {
	updateState();
	terminalScreen.render();
});

ydoc.on("update", () => {
	updateState();
	updateSyncStore();
	terminalScreen.render();
});

// Update interval for connection status
setInterval(() => {
	terminalScreen.render();
}, 1000);

// Quit on Escape, q, or Control-C
terminalScreen.key(["escape", "q", "C-c"], () => {
	return process.exit(0);
});

// Initial render
updateState();
updateSyncStore();
terminalScreen.render();

console.log("Debug monitor started");
