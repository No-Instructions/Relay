<script lang="ts">
	import type { RelayUser, RemoteSharedFolder, Role } from "src/Relay";
	import type { RelayManager } from "src/RelayManager";
	import { derived, writable } from "svelte/store";
	import { handleServerError } from "src/utils/toastStore";

	export let relayManager: RelayManager;
	export let folder: RemoteSharedFolder;
	export let onAdd: (userIds: string[], role: Role) => Promise<void>;
	export let preSelectedUserIds: string[] = [];

	interface UserSelection {
		user: RelayUser;
		hasAccess: boolean;
		selected: boolean;
		isOwner: boolean;
		isCurrentUser: boolean;
	}

	const selectedUsers = writable(new Set([...preSelectedUserIds]));
	const searchQuery = writable("");

	// Create derived store for users in this relay
	const relayUsers = derived(
		[relayManager.relayRoles],
		([$relayRoles]) => {
			return $relayRoles
				.values()
				.filter((role) => role.relayId === folder.relayId)
				.map((role) => role.user);
		}
	);

	// Create derived store for folder roles
	const currentFolderRoles = derived(
		[relayManager.folderRoles],
		([$folderRoles]) => {
			return $folderRoles.values().filter((role) => role.sharedFolderId === folder.id);
		}
	);

	// Create derived store for user selections
	const users = derived(
		[relayUsers, currentFolderRoles, selectedUsers],
		([$relayUsers, $folderRoles, $selectedUsers]) => {
			const usersWithAccess = new Set($folderRoles.map((role) => role.userId));
			const folderOwnerIds = new Set(
				$folderRoles
					.filter((role) => role.role === "Owner")
					.map((role) => role.userId)
			);
			const currentUserId = relayManager.user?.id;

			return $relayUsers.map((user) => {
				const isFolderOwner = folderOwnerIds.has(user.id);
				const isCurrentUser = currentUserId === user.id;
				const selected = $selectedUsers.has(user.id);
				return {
					user,
					hasAccess: usersWithAccess.has(user.id),
					selected,
					isOwner: isFolderOwner,
					isCurrentUser,
				};
			});
		}
	);
	
	const filteredUsers = derived(
		[users, searchQuery],
		([$users, $searchQuery]) => {
			if (!$searchQuery) return $users;
			const query = $searchQuery.toLowerCase();
			return $users.filter((userSelection) =>
				userSelection.user.name.toLowerCase().includes(query)
			);
		}
	);

	// Sort: users without access first, then by name
	const sortedUsers = derived(
		[filteredUsers],
		([$filteredUsers]) => {
			return $filteredUsers.sort((a, b) => {
				if (a.hasAccess && !b.hasAccess) return 1;
				if (!a.hasAccess && b.hasAccess) return -1;
				return a.user.name.localeCompare(b.user.name);
			});
		}
	);

	const selectedCount = derived(
		[selectedUsers],
		([$selectedUsers]) => $selectedUsers.size
	);

	function toggleUser(userSelection: UserSelection) {
		if (userSelection.hasAccess) return;

		selectedUsers.update(current => {
			const newSet = new Set(current);
			if (newSet.has(userSelection.user.id)) {
				newSet.delete(userSelection.user.id);
			} else {
				newSet.add(userSelection.user.id);
			}
			return newSet;
		});
	}

	async function handleAdd() {
		const currentSelectedUsers = $selectedUsers;
		if (currentSelectedUsers.size === 0) return;

		try {
		    await onAdd(Array.from(currentSelectedUsers), "Member");
		} catch (error) {
			handleServerError(error);
		}
	}

	function getInitials(name: string): string {
		return name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.substring(0, 2);
	}
</script>

<div class="modal-title">Invite users to this folder</div>

<div class="modal-content user-select-modal">
	<div class="search-container">
		<input
			type="text"
			placeholder="Search users by name..."
			bind:value={$searchQuery}
			class="search-input"
		/>
	</div>

	<div class="user-list">
		{#if $sortedUsers.length === 0}
			<div class="no-users">
				{$searchQuery ? "No users found" : "No users available"}
			</div>
		{:else}
			{#each $sortedUsers as userSelection}
				<div
					class="user-item"
					class:has-access={userSelection.hasAccess}
					class:is-owner={userSelection.isOwner}
					class:is-current-user={userSelection.isCurrentUser}
					on:click={() => toggleUser(userSelection)}
					on:keydown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							toggleUser(userSelection);
						}
					}}
					role="button"
					tabindex="0"
				>
					<input
						type="checkbox"
						checked={userSelection.selected}
						disabled={userSelection.hasAccess}
						class="user-checkbox"
						on:click={(e) => {
							e.stopPropagation();
							toggleUser(userSelection);
						}}
					/>

					<div class="user-avatar">
						{#if userSelection.user.picture}
							<img
								src={userSelection.user.picture}
								alt={userSelection.user.name}
							/>
						{:else}
							{getInitials(userSelection.user.name)}
						{/if}
					</div>

					<div class="user-info">
						<div class="user-name">{userSelection.user.name}</div>
					</div>

					{#if userSelection.hasAccess}
						<div class="user-status">Already has access</div>
					{:else if userSelection.isCurrentUser}
						<div class="user-status">(You)</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>

	<div class="modal-button-container">
		<span class="selection-count">
			{$selectedCount === 0
				? "No users selected"
				: `${$selectedCount} user${$selectedCount === 1 ? "" : "s"} selected`}
		</span>

		<button class="mod-cta" disabled={$selectedCount === 0} on:click={handleAdd}>
			Add Users
		</button>
	</div>
</div>

<style>
	.search-container {
		margin-bottom: 16px;
	}

	.search-input {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		background: var(--background-primary);
		color: var(--text-normal);
	}

	.user-list {
		flex: 1;
		max-height: 400px;
		overflow-y: auto;
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		background: var(--background-primary);
		margin-bottom: 16px;
	}

	.user-item {
		display: flex;
		align-items: center;
		padding: 12px;
		border-bottom: 1px solid var(--background-modifier-border);
		cursor: pointer;
		gap: 12px;
	}

	.user-item:last-child {
		border-bottom: none;
	}

	.user-item:hover:not(.has-access) {
		background: var(--background-modifier-hover);
	}

	.user-item.has-access {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.user-checkbox {
		margin: 0;
		cursor: pointer;
	}

	.user-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--interactive-accent);
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-size: 12px;
		font-weight: 500;
		flex-shrink: 0;
	}

	.user-avatar img {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		object-fit: cover;
	}

	.user-info {
		flex: 1;
		min-width: 0;
	}

	.user-name {
		font-weight: 500;
		margin-bottom: 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}


	.user-status {
		font-size: 0.8em;
		color: var(--text-muted);
		font-style: italic;
	}

	.no-users {
		text-align: center;
		padding: 40px;
		color: var(--text-muted);
	}

	.modal-button-container {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 16px;
	}

	.selection-count {
		color: var(--text-muted);
		font-size: 0.9em;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
