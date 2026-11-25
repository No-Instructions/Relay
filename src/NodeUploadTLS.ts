import type { Agent } from "https";

let cached: { defaults: readonly string[]; system: readonly string[]; agent: Agent } | undefined;

/** Scope the TLS context and its reusable connections to desktop attachment uploads. */
export async function nodeUploadAgent(target: URL): Promise<Agent | undefined> {
	if (target.protocol !== "https:") return;
	const [tls, https] = await Promise.all([import("tls"), import("https")]);
	const { getCACertificates } = tls as typeof tls & {
		getCACertificates?: (source: "system" | "default") => readonly string[];
	};
	if (!getCACertificates) return;
	const system = getCACertificates("system");
	if (!system.length) return;
	const defaults = getCACertificates("default");
	if (cached && cached.defaults === defaults && cached.system === system) return cached.agent;
	// Supplying ca replaces Node's effective defaults, including NODE_EXTRA_CA_CERTS.
	const options = https.globalAgent.options;
	const secureContext = tls.createSecureContext({ ...options, ca: [...new Set([...defaults, ...system])] });
	const agent = new https.Agent({ ...options, secureContext });
	cached = { defaults, system, agent };
	return agent;
}
