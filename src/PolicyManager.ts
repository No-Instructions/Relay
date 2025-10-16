import type { Permission, Resource } from "./Relay";
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
	resource: Resource; // Resource identifier (["relay", id])
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
	 * - "folder_roles": (role, request) => role.userId === request.principal
	 * - "folder_roles:target": (role, request) => role.sharedFolderId === getResourceId(request.resource)
	 * - "relay_roles": (role, request) => role.userId === request.principal
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
	protected unsubscribes: (() => void)[] = [];
	private currentValue: boolean;
	private subscriberCount: number = 0;
	observableName = "ObservablePermission";

	constructor(
		private evaluate: () => boolean,
		dependencies: ObservableMap<any, any>[],
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
			this.unsubscribes.push(unsub);
		});
	}

	subscribe(run: (value: boolean) => void): () => void {
		if (this.destroyed) {
			throw new Error("Cannot subscribe to destroyed ObservablePermission");
		}

		this.subscriberCount++;

		run(this.currentValue);

		const unsubscribe = this.on(() => {
			run(this.currentValue);
		});

		return () => {
			unsubscribe();
			this.subscriberCount--;

			// Auto-cleanup when no subscribers remain
			if (this.subscriberCount === 0) {
				this.destroy();
			}
		};
	}

	destroy() {
		if (this.destroyed) return;

		this.destroyed = true;

		this.unsubscribes.forEach((unsub) => unsub());
		this.unsubscribes.length = 0;

		this._listeners?.clear();
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
		permission: Permission,
		resource: Resource,
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

	can(
		principal: string,
		permission: Permission,
		resource: Resource,
		context?: Record<string, any>,
	): ObservablePermission {
		const resourceType = this.getResourceType(resource);
		const action = permission[1];
		if (permission[0] !== resource[0]) {
			throw new Error(
				`unexpected permission/resource mismatch ${permission[0]} ${resource[0]}`,
			);
		}
		const policyKey = `${resourceType}:${action}`;
		const policy = this.policies.get(policyKey);
		const request = { principal, action, resource, context };

		const dependencies = policy
			? this.getFilteredCollections(policy.dependencies, request)
			: [];

		return new ObservablePermission(() => {
			const result = this.isAllowed(request);
			return result.allowed;
		}, dependencies);
	}

	getPolicies(): string[] {
		return Array.from(this.policies.keys()).sort();
	}

	registerPolicy(policy: PolicyDefinition): void {
		const [resourceType, action] = policy.permission;
		const policyKey = `${resourceType}:${action}`;
		this.policies.set(policyKey, policy);
	}

	private getResourceType(resource: Resource): string {
		return resource[0];
	}

	private getResourceId(resource: Resource): string {
		return resource[1];
	}

	private getFilteredCollections(
		dependencies: Record<
			string,
			(item: any, request: AuthorizationRequest) => boolean
		>,
		request: AuthorizationRequest,
	): ObservableMap<any, any>[] {
		const collections: ObservableMap<any, any>[] = [];

		for (const collectionKey of Object.keys(dependencies)) {
			const collection =
				this.relayManager.getCollectionMapByName(collectionKey);
			if (collection) {
				collections.push(collection);
			}
		}

		return collections;
	}

	private registerBuiltinPolicies(): void {
		// Folder Management Policies
		this.registerPolicy({
			permission: ["folder", "delete"],
			description: "Delete a shared folder",
			dependencies: {
				folder_roles: (role, request) =>
					!!(
						role.sharedFolderId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(
						folder &&
						role.relayId === folder.relayId &&
						role.userId === request.principal
					);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderDelete.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "rename"],
			description: "Rename a shared folder",
			dependencies: {
				folder_roles: (role, request) =>
					!!(
						role.sharedFolderId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(
						folder &&
						role.relayId === folder.relayId &&
						role.userId === request.principal
					);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderRename.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "read_content"],
			description: "Read folder contents and add to vault",
			dependencies: {
				folder_roles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderRead.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "edit_content"],
			description: "Edit notes in folder",
			dependencies: {
				folder_roles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderWrite.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "upload"],
			description: "Upload attachments to folder",
			dependencies: {
				folder_roles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
				relays: (relay, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && relay.id === folder.relayId);
				},
				storage_quotas: (quota, request) => {
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
				folder_roles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderDownload.bind(this),
		});

		this.registerPolicy({
			permission: ["folder", "manage_files"],
			description: "Add/remove/rename files in folder",
			dependencies: {
				folder_roles: (role, request) =>
					role.sharedFolderId === this.getResourceId(request.resource),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(folder && role.relayId === folder.relayId);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderManageFiles.bind(this),
		});

		// Relay Management Policies
		this.registerPolicy({
			permission: ["relay", "delete"],
			description: "Delete a relay server",
			dependencies: {
				relay_roles: (role, request) =>
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
				relay_roles: (role, request) =>
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
				relay_roles: (role, request) =>
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
				relay_roles: (role, request) =>
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
				relay_roles: (role, request) =>
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
				folder_roles: (role, request) =>
					!!(
						role.sharedFolderId === this.getResourceId(request.resource) &&
						role.userId === request.principal
					),
				relay_roles: (role, request) => {
					const folder = this.relayManager.remoteFolders.get(
						this.getResourceId(request.resource),
					);
					return !!(
						folder &&
						role.relayId === folder.relayId &&
						role.userId === request.principal
					);
				},
				shared_folders: (folder, request) =>
					!!(folder.id === this.getResourceId(request.resource)),
			},
			evaluate: this.evaluateFolderManageUsers.bind(this),
		});
	}

	// Helper methods for common permission patterns

	private isFolderCreator(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		return !!(folder?.creatorId === userId);
	}

	private isRelayOwnerForFolder(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		return this.isRelayOwner(userId, folder.relayId);
	}

	private isRelayOwner(userId: string, relayId: string): boolean {
		const relayRole = this.relayManager.relayRoles.find(
			(role) =>
				role.relayId === relayId &&
				role.userId === userId &&
				role.role === "Owner",
		);
		return !!relayRole;
	}

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

	private hasFolderAccess(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		// Check if user has any folder role - all assigned roles grant at least read access
		const userRole = this.getUserFolderRole(userId, folderId);
		if (userRole) return true;

		// For public folders, check if user has relay access
		if (!folder.private) {
			const relayRole = this.getUserRelayRole(userId, folder.relayId);
			return !!relayRole;
		}

		return false;
	}

	private hasFolderWriteAccess(userId: string, folderId: string): boolean {
		const folder = this.relayManager.remoteFolders.get(folderId);
		if (!folder) return false;

		// Check folder role first (for both private and public folders)
		const folderRole = this.getUserFolderRole(userId, folderId);
		if (folderRole && this.roleHasWritePermission(folderRole)) {
			return true;
		}

		// For public folders, check relay role
		if (!folder.private) {
			const relayRole = this.getUserRelayRole(userId, folder.relayId);
			if (relayRole && this.roleHasWritePermission(relayRole)) {
				return true;
			}
		}

		return false;
	}

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

	private getUserFolderRole(userId: string, folderId: string): string | null {
		const folderRole = this.relayManager.folderRoles.find(
			(role) =>
				role.sharedFolderId === folderId &&
				role.userId === userId
		);
		return folderRole?.role || null;
	}

	private getUserRelayRole(userId: string, relayId: string): string | null {
		const relayRole = this.relayManager.relayRoles.find(
			(role) =>
				role.relayId === relayId &&
				role.userId === userId
		);
		return relayRole?.role || null;
	}

	private roleHasWritePermission(roleName: string): boolean {
		// Explicit write permission mapping - extensible for future roles
		const writeRoles = ["Owner", "Member"]; // Reader deliberately excluded
		return writeRoles.includes(roleName);
	}

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
