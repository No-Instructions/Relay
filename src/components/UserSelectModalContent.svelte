<script lang="ts">
	import type { RelayUser, RemoteSharedFolder, Role } from "src/Relay";
	import type { RelayManager } from "src/RelayManager";

	export let relayManager: RelayManager;
	export let folder: RemoteSharedFolder;
	export let onAdd: (userIds: string[], role: Role) => Promise<void>;
	export let preSelectedUserIds: string[] = [];

	interface UserSelection {
		user: RelayUser;
		hasAccess: boolean;
		selected: boolean;
	}

	let users: UserSelection[] = [];
	let selectedUsers: Set<string> = new Set();
	let searchQuery = "";

	// Setup users
	function setupUsers() {
		// Get all users from the relay
		const relay = folder.relay;
		const relayRoles = relayManager.relayRoles.values().filter(
			(role) => role.relayId === relay.id
		);
		const availableUsers = relayRoles.map((role) => role.user);

		// Get users who already have access to this folder
		const folderRoles = relayManager.folderRoles.values().filter(
			(role) => role.sharedFolderId === folder.id
		);
		const usersWithAccess = new Set(folderRoles.map((role) => role.userId));

		// Setup user selection data
		users = availableUsers.map((user) => ({
			user,
			hasAccess: usersWithAccess.has(user.id),
			selected: preSelectedUserIds.includes(user.id),
		}));
		
		// Initialize selectedUsers with pre-selected users
		selectedUsers = new Set(preSelectedUserIds);
	}

	setupUsers();

	$: filteredUsers = users.filter((userSelection) => {
		if (!searchQuery) return true;
		const query = searchQuery.toLowerCase();
		return (
			userSelection.user.name.toLowerCase().includes(query) ||
			userSelection.user.email.toLowerCase().includes(query)
		);
	});

	// Sort: users without access first, then by name
	$: sortedUsers = filteredUsers.sort((a, b) => {
		if (a.hasAccess && !b.hasAccess) return 1;
		if (!a.hasAccess && b.hasAccess) return -1;
		return a.user.name.localeCompare(b.user.name);
	});

	$: selectedCount = selectedUsers.size;

	function toggleUser(userSelection: UserSelection) {
		if (userSelection.hasAccess) return;
		
		userSelection.selected = !userSelection.selected;
		if (userSelection.selected) {
			selectedUsers.add(userSelection.user.id);
		} else {
			selectedUsers.delete(userSelection.user.id);
		}
		// Trigger reactivity by creating a new Set
		selectedUsers = new Set(selectedUsers);
		// Force update of users array to trigger re-render
		users = [...users];
	}

	async function handleAdd() {
		if (selectedUsers.size === 0) return;
		await onAdd(Array.from(selectedUsers), "Member");
	}

	function getInitials(name: string): string {
		return name
			.split(" ")
			.map(n => n[0])
			.join("")
			.toUpperCase()
			.substring(0, 2);
	}
</script>

<div class="modal-title">Add Users to Folder</div>

<div class="modal-content user-select-modal">
		
		<div class="search-container">
			<input
				type="text"
				placeholder="Search users by name or email..."
				bind:value={searchQuery}
				class="search-input"
			/>
		</div>

		<div class="user-list">
			{#if sortedUsers.length === 0}
				<div class="no-users">
					{searchQuery ? "No users found" : "No users available"}
				</div>
			{:else}
				{#each sortedUsers as userSelection}
					<div 
						class="user-item" 
						class:has-access={userSelection.hasAccess}
						on:click={() => toggleUser(userSelection)}
						on:keydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
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
								<img src={userSelection.user.picture} alt={userSelection.user.name} />
							{:else}
								{getInitials(userSelection.user.name)}
							{/if}
						</div>

						<div class="user-info">
							<div class="user-name">{userSelection.user.name}</div>
							{#if userSelection.user.email}
								<div class="user-email">{userSelection.user.email}</div>
							{/if}
						</div>

						{#if userSelection.hasAccess}
							<div class="user-status">Already has access</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>

		<div class="modal-button-container">
			<span class="selection-count">
				{selectedCount === 0 ? "No users selected" : `${selectedCount} user${selectedCount === 1 ? '' : 's'} selected`}
			</span>

			<button 
				class="mod-cta" 
				disabled={selectedCount === 0}
				on:click={handleAdd}
			>
				Add Users
			</button>
		</div>
</div>

<style>
	.user-select-modal {
		min-width: 500px;
		max-width: 600px;
	}

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

	.user-email {
		font-size: 0.9em;
		color: var(--text-muted);
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