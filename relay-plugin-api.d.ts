import type { EventRef } from "obsidian";

/**
 * Type declarations for Relay's public plugin API.
 *
 * Listen for `system3-relay:api-ready:v1` to receive a typed V1 API when
 * Relay provides it. Direct plugin registry access is a runtime boundary; check
 * that `api.version === 1` before treating a registry value as RelayPublicApiV1.
 *
 * V1 is intentionally narrow: it resolves the service user IDs stored by
 * consumers without exposing Relay internals.
 */

export interface RelayIdentity {
	id: string;
	name: string;
	picture?: string;
	color?: string;
	colorLight?: string;
}

export interface RelayIdentityApi {
	getCurrentUser(path: string): Promise<RelayIdentity | null>;
	resolveUser(id: string, path: string): Promise<RelayIdentity | null>;
	getAuthorForRange?(
		path: string,
		from: number,
		to: number,
	): Promise<RelayIdentity | null>;
}

export interface RelayPublicApiV1 {
	version: 1;
	identity: RelayIdentityApi;
}

declare module "obsidian" {
	interface Workspace {
		on(
			name: "system3-relay:api-ready:v1",
			callback: (api: RelayPublicApiV1) => void,
		): EventRef;
		trigger(name: "system3-relay:api-ready:v1", api: RelayPublicApiV1): void;
	}
}
