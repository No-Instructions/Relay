import type { EventRef } from "obsidian";

/**
 * Type declarations for Relay's public plugin API.
 *
 * Listen for `system3-relay:api-ready:v1` to receive a typed V1 API when
 * Relay provides it. Expect up to two calls per Relay load (once when Relay
 * loads and once when the workspace layout is ready, so listeners registered
 * either side of layout restore still get it); the api object is the same
 * cacheable, idempotent value each time, so handling the event more than once
 * is safe and consumers should simply keep the latest one.
 *
 * Direct plugin registry access is a runtime boundary; check
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
	/**
	 * Resolves the local user's identity, or null when `path` is not inside a
	 * folder Relay shares.
	 */
	getCurrentUser(path: string): Promise<RelayIdentity | null>;
	/**
	 * Resolves a user id to an identity, or null when `path` is not inside a
	 * folder Relay shares, or when the id does not belong to a member of that
	 * folder. Ids are only resolvable within the folder that produced them.
	 */
	resolveUser(id: string, path: string): Promise<RelayIdentity | null>;
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
