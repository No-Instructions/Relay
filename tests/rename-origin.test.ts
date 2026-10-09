import type { Api as ConsumerApi } from "../relay-plugin-api";
import { RenameOrigins, getRenameOrigins, renameFromRelay } from "../src/RenameOrigin";
import { createPublicApi, API_UNLOADED_ERROR } from "../src/PublicAPI";

function api(origins = new RenameOrigins()) {
	const handle = createPublicApi(
		{ users: { values: () => [], on: () => () => {} } } as any,
		{ on: () => () => {} } as any,
		{ register: jest.fn(), unregister: jest.fn() } as any,
		{ trigger: jest.fn() }, () => {}, (oldPath, newPath) => origins.get(oldPath, newPath),
	);
	const consumerApi: ConsumerApi = handle.api;
	handle.api = consumerApi;
	return handle;
}

test("v0 distinguishes the exact propagated pair synchronously and clears it afterward", async () => {
	const origins = new RenameOrigins();
	const handle = api(origins);
	const file = { path: "watched/old.md" } as any;
	await origins.relayRename(file, "watched/new.md", async () => {
		expect(handle.api.v0.getRenameOrigin(file.path, "watched/new.md")).toBe("relay");
		expect(handle.api.v0.getRenameOrigin(file.path, "watched/other.md")).toBe("client");
		expect(handle.api.v0.getRenameOrigin("elsewhere/old.md", "watched/new.md")).toBe("client");
	});
	expect(handle.api.v0.getRenameOrigin(file.path, "watched/new.md")).toBe("client");
	handle.detach();
	expect(() => handle.api.v0.getRenameOrigin(file.path, "watched/new.md")).toThrow(API_UNLOADED_ERROR);
});

test("overlapping identical renames remain marked until both settle, including failure", async () => {
	const origins = new RenameOrigins();
	const file = { path: "old.md" } as any;
	let finish!: () => void;
	const first = origins.relayRename(file, "new.md", () => new Promise<void>(resolve => { finish = resolve; }));
	await expect(origins.relayRename(file, "new.md", async () => { throw new Error("disk failed"); })).rejects.toThrow("disk failed");
	expect(origins.get("old.md", "new.md")).toBe("relay");
	finish();
	await first;
	expect(origins.get("old.md", "new.md")).toBe("client");
});

test("rename scopes are shared by one vault and isolated between apps", () => {
	const manager = {} as any;
	expect(getRenameOrigins(manager)).toBe(getRenameOrigins(manager));
	expect(getRenameOrigins({} as any)).not.toBe(getRenameOrigins(manager));
});

test("folder propagation classifies child events and does not match neighboring paths", async () => {
	const origins = new RenameOrigins();
	await origins.relayRename({ path: "watched/old" } as any, "watched/new", async () => {
		expect(origins.get("watched/old/child.md", "watched/new/child.md")).toBe("relay");
		expect(origins.get("watched/older/child.md", "watched/new/child.md")).toBe("client");
		expect(origins.get("watched/old/child.md", "watched/new/other.md")).toBe("client");
	});
});


test("queued FileManager completion cannot clear origin before the actual vault rename", async () => {
	const file = { path: "old.md" } as any;
	const seen: string[] = [];
	const vault = {
		rename: async (target: any, path: string) => {
			seen.push(getRenameOrigins(vault as any).get(target.path, path));
			target.path = path;
		},
	};
	const original = vault.rename;
	let queued!: () => Promise<void>;
	let finished = false;
	const operation = renameFromRelay(vault as any, file, "new.md", async () => {
		queued = () => vault.rename(file, "new.md");
	}).then(() => { finished = true; });
	await Promise.resolve();
	await Promise.resolve();
	expect(finished).toBe(false);
	await vault.rename({ path: "unrelated.md" }, "elsewhere.md");
	expect(seen).toEqual(["client"]);
	await queued();
	await operation;
	expect(seen).toEqual(["client", "relay"]);
	expect(finished).toBe(true);
	expect(vault.rename).toBe(original);
	expect(getRenameOrigins(vault as any).get("old.md", "new.md")).toBe("client");
});

test("actual vault failure and FileManager rejection restore the wrapper", async () => {
	const file = { path: "old.md" } as any;
	const vault = { rename: jest.fn(async () => { throw new Error("disk failed"); }) };
	const original = vault.rename;
	await expect(renameFromRelay(vault as any, file, "new.md", () =>
		(vault.rename as any)(file, "new.md"),
	)).rejects.toThrow("disk failed");
	expect(vault.rename).toBe(original);
	expect(getRenameOrigins(vault as any).get("old.md", "new.md")).toBe("client");
	await expect(renameFromRelay(vault as any, file, "new.md", async () => {
		throw new Error("queue rejected");
	})).rejects.toThrow("queue rejected");
	expect(vault.rename).toBe(original);
});

test("overlapping queued server renames on one vault retain their own scopes", async () => {
	const first = { path: "first.md" } as any;
	const second = { path: "second.md" } as any;
	const seen: string[] = [];
	const vault = { rename: async (file: any, path: string) => {
		seen.push(getRenameOrigins(vault as any).get(file.path, path));
		file.path = path;
	} };
	const original = vault.rename;
	let runFirst!: () => Promise<void>;
	let runSecond!: () => Promise<void>;
	const a = renameFromRelay(vault as any, first, "first-new.md", async () => {
		runFirst = () => vault.rename(first, "first-new.md");
	});
	const b = renameFromRelay(vault as any, second, "second-new.md", async () => {
		runSecond = () => vault.rename(second, "second-new.md");
	});
	await Promise.resolve();
	await runFirst();
	await a;
	await runSecond();
	await b;
	await vault.rename({ path: "local.md" }, "local-new.md");
	expect(seen).toEqual(["relay", "relay", "client"]);
	expect(vault.rename).toBe(original);
});

test("no-op destinations do not wait for a vault rename", async () => {
	const file = { path: "same.md" } as any;
	const vault = { rename: jest.fn() };
	const rename = jest.fn(async () => {});
	await renameFromRelay(vault as any, file, file.path, rename);
	expect(rename).toHaveBeenCalledTimes(1);
	expect(vault.rename).not.toHaveBeenCalled();
});

test("synchronous disk failures clean up the scope and wrapper", async () => {
	const file = { path: "old.md" } as any;
	const vault = { rename: () => { throw new Error("sync failure"); } };
	const original = vault.rename;
	await expect(renameFromRelay(vault as any, file, "new.md", () =>
		(vault.rename as any)(file, "new.md"),
	)).rejects.toThrow("sync failure");
	expect(vault.rename).toBe(original);
	expect(getRenameOrigins(vault as any).get("old.md", "new.md")).toBe("client");
});

test("a simulated 22-client move selects only the originating client's side effect", async () => {
	const clients = Array.from({ length: 22 }, () => {
		let origin: string | undefined;
		const vault = {
			rename: async (file: { path: string }, path: string) => {
				const oldPath = file.path;
				file.path = path;
				// Simulate the synchronous vault rename callback.
				origin = handle.api.v0.getRenameOrigin(oldPath, file.path);
			},
		};
		const handle = api(getRenameOrigins(vault as any));
		return { vault, handle, origin: () => origin };
	});
	await clients[0].vault.rename({ path: "old.md" }, "new.md");
	for (const client of clients.slice(1)) {
		const file = { path: "old.md" } as any;
		await renameFromRelay(client.vault as any, file, "new.md", () =>
			client.vault.rename(file, "new.md"),
		);
	}
	expect(clients.filter(client => client.origin() === "client")).toHaveLength(1);
	expect(clients.filter(client => client.origin() === "relay")).toHaveLength(21);
	clients.forEach(client => client.handle.detach());
});

test("FileManager rejection after disk invocation keeps the delayed event marked", async () => {
	const file = { path: "old.md" } as any;
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	let seen: string | undefined;
	const vault = {
		rename: async (target: typeof file, path: string) => {
			await pending;
			const oldPath = target.path;
			target.path = path;
			seen = handle.api.v0.getRenameOrigin(oldPath, target.path);
		},
	};
	const original = vault.rename;
	const handle = api(getRenameOrigins(vault as any));
	let disk!: Promise<void>;
	await expect(renameFromRelay(vault as any, file, "new.md", async () => {
		disk = vault.rename(file, "new.md");
		throw new Error("FileManager failed after invocation");
	})).rejects.toThrow("FileManager failed after invocation");
	expect(vault.rename).toBe(original);
	expect(handle.api.v0.getRenameOrigin("old.md", "new.md")).toBe("relay");
	finish();
	await disk;
	expect(seen).toBe("relay");
	expect(handle.api.v0.getRenameOrigin("old.md", "new.md")).toBe("client");
	handle.detach();
});
