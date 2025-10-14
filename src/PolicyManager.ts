import type { Permission } from "./Relay";
import type { RelayManager } from "./RelayManager";
import { Observable } from "./observable/Observable";
import type { ObservableMap } from "./observable/ObservableMap";
import type { Readable } from "svelte/store";

/**
 * Standard policy request with principal, action, and resource
 */
export interface AuthorizationRequest {
	principal: string; // User ID
	action: string; // What action to perform
	resource: string; // Resource identifier (relay:id, folder:id, etc.)
	context?: Record<string, any>; // Additional context (file size, etc.)
}

/**
 * Result of a policy evaluation
 */
export interface AuthorizationResult {
	allowed: boolean;
	policy?: string;
	context?: {
		resourceType?: string;
		action?: string;
		principal?: string;
	};
}

/**
 * Policy definition with principal/action/resource pattern
 */
export interface PolicyDefinition {
	/**
	 * Policy identifier in format: [resource, action]
	 */
	permission: Permission;

	/**
	 * Human-readable description
	 */
	description: string;

	/**
	 * Dependencies map: collection name (with optional alias) -> filter function
	 * Examples:
	 * - "folderRoles": (role, request) => role.userId === request.principal
	 * - "folderRoles:target": (role, request) => role.sharedFolderId === getResourceId(request.resource)
	 * - "relayRoles": (role, request) => role.userId === request.principal
	 */
	dependencies: Record<
		string,
		(item: any, request: AuthorizationRequest) => boolean
	>;

	/**
	 * Policy evaluation function
	 */
	evaluate: (
		request: AuthorizationRequest,
		relayManager: RelayManager,
	) => boolean;
}

/**
 * Observable permission that automatically updates when dependencies change
 * Implements Svelte store contract for native reactivity
 */
export class ObservablePermission
	extends Observable<boolean>
	implements Readable<boolean>
{
	private unsubscribers: (() => void)[] = [];
	private currentValue: boolean;

	constructor(
		private evaluate: () => boolean,
		private dependencies: ObservableMap<any, any>[],
	) {
		super();
		this.currentValue = this.evaluate();

		// Subscribe to all dependency collections
		dependencies.forEach((dep) => {
			const unsub = dep.on(() => {
				const newValue = this.evaluate();
				if (newValue !== this.currentValue) {
					this.currentValue = newValue;
					this.notifyListeners();
				}
			});
			this.unsubscribers.push(unsub);
		});
	}

	/**
	 * Get current permission value synchronously
	 * Note: Use import { get } from 'svelte/store'; get(permission) for standard approach
	 */
	get current(): boolean {
		return this.currentValue;
	}

	/**
	 * Svelte store contract: subscribe method
	 * This allows using $permission syntax in Svelte
	 */
	subscribe(run: (value: boolean) => void): () => void {
		// Call immediately with current value
		run(this.currentValue);

		// Subscribe to future changes
		const unsubscribe = this.on(() => {
			run(this.currentValue);
		});

		return unsubscribe;
	}

	/**
	 * Clean up subscriptions
	 */
	destroy() {
		this.unsubscribers.forEach((unsub) => unsub());
		this.unsubscribers = [];
		super.destroy();
	}
}

/**
 * Policy manager interface
 */
export interface IPolicyManager {
	/**
	 * Check if an action is allowed on a resource by a principal
	 */
	isAllowed(request: AuthorizationRequest): AuthorizationResult;

	/**
	 * Reactive permission check - returns observable that updates when permissions change
	 */
	can(
		principal: string,
		action: string,
		resource: string,
		context?: Record<string, any>,
	): ObservablePermission;

	/**
	 * Get all registered policies
	 */
	getPolicies(): string[];

	/**
	 * Register a policy definition
	 */
	registerPolicy(policy: PolicyDefinition): void;
}

/**
 * Centralized policy manager that operates alongside RelayManager's graph
 */
export class PolicyManager implements IPolicyManager {
	private policies: Map<string, PolicyDefinition> = new Map();

	constructor(private relayManager: RelayManager) {
		this.registerBuiltinPolicies();
	}

	/**
	 * Check if an action is allowed on a resource by a principal
	 */
	isAllowed(request: AuthorizationRequest): AuthorizationResult {
		const resourceType = this.getResourceType(request.resource);
		const policyKey = `${resourceType}:${request.action}`;
		const policy = this.policies.get(policyKey);

		if (!policy) {
			return {
				allowed: false,
				policy: policyKey,
				context: {
					resourceType,
					action: request.action,
					principal: request.principal,
				},
			};
		}

		try {
			const allowed = policy.evaluate(request, this.relayManager);
			return {
				allowed,
				policy: policyKey,
				context: {
					resourceType,
					action: request.action,
					principal: request.principal,
				},
			};
		} catch (error) {
			return {
				allowed: false,
				policy: policyKey,
				context: {
					resourceType,
					action: request.action,
					principal: request.principal,
				},
			};
		}
	}

	/**
	 * Reactive permission check - returns observable that updates when permissions change
	 */
	can(
		principal: string,
		action: string,
		resource: string,
		context?: Record<string, any>,
	): ObservablePermission {
		const resourceType = this.getResourceType(resource);
		const policyKey = `${resourceType}:${action}`;
		const policy = this.policies.get(policyKey);
		const request = { principal, action, resource, context };

		// Get dependencies from policy definition, fallback to default
		const dependencies = policy
			? this.getFilteredCollections(policy.dependencies, request)
			: this.getDefaultDependencies(resourceType);

		return new ObservablePermission(() => {
			const result = this.isAllowed(request);
			return result.allowed;
		}, dependencies);
	}

	/**
	 * Get all registered policies
	 */
	getPolicies(): string[] {
		return Array.from(this.policies.keys()).sort();
	}

	/**
	 * Register a policy definition
	 */
	registerPolicy(policy: PolicyDefinition): void {
		const [resourceType, action] = policy.permission;
		const policyKey = `${resourceType}:${action}`;
		this.policies.set(policyKey, policy);
	}

	/**
	 * Extract resource type from resource string
	 * Examples: "folder:abc123" -> "folder", "relay:xyz789" -> "relay"
	 */
	private getResourceType(resource: string): string {
		const colonIndex = resource.indexOf(":");
		return colonIndex > 0 ? resource.substring(0, colonIndex) : resource;
	}

	/**
	 * Extract resource ID from resource string
	 * Examples: "folder:abc123" -> "abc123", "relay:xyz789" -> "xyz789"
	 */
	private getResourceId(resource: string): string {
		const colonIndex = resource.indexOf(":");
		return colonIndex > 0 ? resource.substring(colonIndex + 1) : resource;
	}

	/**
	 * Get filtered collections based on dependency map and request
	 */
	private getFilteredCollections(
		dependencies: Record<
			string,
			(item: any, request: AuthorizationRequest) => boolean
		>,
		request: AuthorizationRequest,
	): ObservableMap<any, any>[] {
		const collections: ObservableMap<any, any>[] = [];

		for (const collectionKey of Object.keys(dependencies)) {
			// Parse potential alias (future: "folderRoles:auth" -> "folderRoles")
			const collectionName = collectionKey.split(":")[0];

			const collection = this.getCollectionByName(collectionName);
			if (collection) {
				collections.push(collection);
			}
		}

		return collections;
	}

	/**
	 * Get collections by their names (legacy support)
	 */
	private getCollectionsByNames(
		collectionNames: string[],
	): ObservableMap<any, any>[] {
		const collections: ObservableMap<any, any>[] = [];

		for (const name of collectionNames) {
			// Parse potential alias (future: "folderRoles:auth" -> "folderRoles")
			const collectionName = name.split(":")[0];

			const collection = this.getCollectionByName(collectionName);
			if (collection) {
				collections.push(collection);
			}
		}

		return collections;
	}

	/**
	 * Get a single collection by name
	 */
	private getCollectionByName(
		name: string,
	): ObservableMap<any, any> | undefined {
		switch (name) {
			case "folderRoles":
				return this.relayManager.folderRoles;
			case "relayRoles":
				return this.relayManager.relayRoles;
			case "remoteFolders":
				return this.relayManager.remoteFolders;
			case "relays":
				return this.relayManager.relays;
			case "storageQuotas":
				return this.relayManager.storageQuotas;
			case "subscriptions":
				return this.relayManager.subscriptions;
			default:
				console.warn(`Unknown collection name: ${name}`);
				return undefined;
		}
	}

	/**
	 * Fallback dependencies for resource types (backward compatibility)
	 */
	private getDefaultDependencies(
		resourceType: string,
	): ObservableMap<any, any>[] {
		switch (resourceType) {
			case "folder":
				return this.getCollectionsByNames([
					"folderRoles",
					"relayRoles",
					"remoteFolders",
					"relays",
					"storageQuotas",
				]);
			case "relay":
				return this.getCollectionsByNames([
					"relayRoles",
					"relays",
					"subscriptions",
				]);
			default:
				return this.getCollectionsByNames(["relayRoles", "folderRoles"]);
		}
	}

	/**
	 * Register all built-in permission policies
	 */
	private registerBuiltinPolicies(): void {
		// Folder Management Policies
		this.registerPolicy({
			permission: ["folder", "delete"],
			description: "Delete a shared folder",
			dependencies: {
				folderRoles: (role, request) =>
					!!(
						role.sharedFolderId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(
						folder &&
						role.relayId === folder.relayId &&
						role.userId === request.principal
					);
				},
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderDelete.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "rename"],
			description: "Rename a shared folder",
			dependencies: {
				folderRoles: (role, request) =>
					!!(
						role.sharedFolderId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(
						folder &&
						role.relayId === folder.relayId &&
						role.userId === request.principal
					);
				},
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderRename.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "read_content"],
			description: "Read folder contents and add to vault",
			dependencies: {
				folderRoles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderRead.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "edit_content"],
			description: "Edit notes in folder",
			dependencies: {
				folderRoles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderWrite.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "upload"],
			description: "Upload attachments to folder",
			dependencies: {
				folderRoles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
				relays: (relay, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && relay.id === folder.relayId);
				},
				storageQuotas: (quota, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					const relay = folder && this.relayManager.relays.get(folder.relayId);
					return !!(relay && quota.id === relay.storageQuotaId);
				},
			},
			evaluate: this.evaluateFolderUpload.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "download"],
			description: "Download attachments from folder",
			dependencies: {
				folderRoles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderDownload.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "manage_files"],
			description: "Add/remove/rename files in folder",
			dependencies: {
				folderRoles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderManageFiles.bind(this),
		});

		// Relay Management Policies
		this.registerPolicy({
			permission: ["relay", "delete"],
			description: "Delete a relay server",
			dependencies: {
				relayRoles: (role, request) =>
					!!(
						role.relayId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
			},
			evaluate: this.evaluateRelayDelete.bind(this),
		});

		this.registerPolicy({
			permission: ["relay", "rename"],
			description: "Rename a relay server",
			dependencies: {
				relayRoles: (role, request) =>
					!!(
						role.relayId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
			},
			evaluate: this.evaluateRelayRename.bind(this),
		});

		this.registerPolicy({
			permission: ["relay", "manage_users"],
			description: "Manage users in relay server (add/remove/change roles)",
			dependencies: {
				relayRoles: (role, request) =>
					!!(
						role.relayId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
			},
			evaluate: this.evaluateRelayManageUsers.bind(this),
		});

		this.registerPolicy({
			permission: ["relay", "manage_sharing"],
			description:
				"Manage relay share keys (enable/disable sharing, rotate keys)",
			dependencies: {
				relayRoles: (role, request) =>
					!!(
						role.relayId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
			},
			evaluate: this.evaluateRelayManageSharing.bind(this),
		});

		this.registerPolicy({
			permission: ["subscription", "manage"],
			description: "Manage relay subscriptions and plans",
			dependencies: {
				relayRoles: (role, request) =>
					!!(
						role.relayId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
			},
			evaluate: this.evaluateSubscriptionManage.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "manage_users"],
			description: "Manage users in folder (add/remove/change roles)",
			dependencies: {
				// There is a folder roles with this folder and user
				folderRoles: (role, request) =>
					!!(
						role.sharedFolderId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
				// There is a relay role with this relay and user
				relayRoles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(
						folder &&
						role.relayId === folder.relayId &&
						role.userId === request.principal
					);
				},
				// This remote folder exists
				remoteFolders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderManageUsers.bind(this),
		});
	}

	// Helper methods for common permission patterns

	/**
	 * Check if user is the creator of a folder
	 */
	private isFolderCreator(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		return !!(folder?.creatorId === userId);
	}

	/**
	 * Check if user is owner of the relay that contains the folder
	 */
	private isRelayOwnerForFolder(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		return this.isRelayOwner(userId, folder.relayId);
	}

	/**
	 * Check if user is owner of a relay
	 */
	private isRelayOwner(userId: string, relayId: string): boolean {
		const relayRole = this.relayManager.relayRoles.find(
			(role) =>
				role.relayId === relayId &&
				role.userId === userId &&
				role.role === "Owner",
		);
		return !!relayRole;
	}

	/**
	 * Check if user has specific role in a relay
	 */
	private hasRelayRole(
		userId: string,
		relayId: string,
		roleName: string | string[],
	): boolean {
		const roles = Array.isArray(roleName) ? roleName : [roleName];
		const relayRole = this.relayManager.relayRoles.find(
			(role) =>
				role.relayId === relayId &&
				role.userId === userId &&
				roles.includes(role.role),
		);
		return !!relayRole;
	}

	/**
	 * Check if user has specific role in a folder
	 */
	private hasFolderRole(
		userId: string,
		folderId: string,
		roleName: string | string[],
	): boolean {
		const roles = Array.isArray(roleName) ? roleName : [roleName];
		const folderRole = this.relayManager.folderRoles.find(
			(role) =>
				role.sharedFolderId === folderId &&
				role.userId === userId &&
				roles.includes(role.role),
		);
		return !!folderRole;
	}

	/**
	 * Check if user has access to a folder (read permission)
	 */
	private hasFolderAccess(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		// For private folders, only explicit folder roles matter
		if (folder.private) {
			return this.hasFolderRole(userId, folderId, ["Owner", "Member"]);
		}

		// For public folders, any relay member has access
		return this.hasRelayRole(userId, folder.relayId, ["Owner", "Member"]);
	}

	/**
	 * Check if user has write permission to a folder
	 */
	private hasFolderWriteAccess(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		// For private folders, only explicit folder roles matter
		if (folder.private) {
			return this.hasFolderRole(userId, folderId, ["Owner", "Member"]);
		}

		// For public folders, any relay member has write access
		return this.hasRelayRole(userId, folder.relayId, ["Owner", "Member"]);
	}

	/**
	 * Check if user has management permissions for a folder (delete/modify/invite)
	 */
	private hasFolderManagementAccess(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		// Relay owner always has management access
		if (this.isRelayOwnerForFolder(userId, folderId)) {
			return true;
		}

		// For private folders, only folder owners can manage
		if (folder.private) {
			return this.hasFolderRole(userId, folderId, ["Owner"]);
		}

		// For public folders, creator can manage
		return this.isFolderCreator(userId, folderId);
	}

	/**
	 * Check storage quota for uploads
	 */
	private hasStorageQuota(folderId: string, fileSize: number): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		const relay = this.relayManager.relays.get(folder.relayId);
		if (!relay) return false;

		const storageQuota = relay.storageQuota;
		if (!storageQuota) return true; // No quota means unlimited

		return storageQuota.usage + fileSize <= storageQuota.quota;
	}

	// Policy Evaluation Methods

	private evaluateFolderDelete(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		return this.hasFolderManagementAccess(request.principal, folderId);
	}

	private evaluateFolderRename(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		return this.hasFolderManagementAccess(request.principal, folderId);
	}

	private evaluateFolderRead(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		return this.hasFolderAccess(request.principal, folderId);
	}

	private evaluateFolderWrite(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		return this.hasFolderWriteAccess(request.principal, folderId);
	}

	private evaluateFolderDownload(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		return this.hasFolderAccess(request.principal, folderId);
	}

	private evaluateFolderManageFiles(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		return this.hasFolderWriteAccess(request.principal, folderId);
	}

	private evaluateFolderUpload(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		const fileSize = request.context?.fileSize || 0;
		return (
			this.hasFolderWriteAccess(request.principal, folderId) &&
			this.hasStorageQuota(folderId, fileSize)
		);
	}

	private evaluateRelayDelete(request: AuthorizationRequest): boolean {
		const relayId = this.getResourceId(request.resource);
		return this.isRelayOwner(request.principal, relayId);
	}

	private evaluateRelayRename(request: AuthorizationRequest): boolean {
		const relayId = this.getResourceId(request.resource);
		return this.isRelayOwner(request.principal, relayId);
	}

	private evaluateRelayManageUsers(request: AuthorizationRequest): boolean {
		const relayId = this.getResourceId(request.resource);
		return this.isRelayOwner(request.principal, relayId);
	}

	private evaluateRelayManageSharing(request: AuthorizationRequest): boolean {
		const relayId = this.getResourceId(request.resource);
		return this.isRelayOwner(request.principal, relayId);
	}

	private evaluateSubscriptionManage(request: AuthorizationRequest): boolean {
		const relayId = this.getResourceId(request.resource);
		return this.isRelayOwner(request.principal, relayId);
	}

	private evaluateFolderManageUsers(request: AuthorizationRequest): boolean {
		const folderId = this.getResourceId(request.resource);
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		// Relay owner can always manage users (to add themselves to private folders)
		if (this.isRelayOwnerForFolder(request.principal, folderId)) {
			return true;
		}

		// For any private folder, folder owners can manage users
		return this.hasFolderRole(request.principal, folderId, ["Owner"]);
	}
}
