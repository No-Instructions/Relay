<script lang="ts">
	import type { App } from "obsidian";
	import type { Relay, RelayUser, Role } from "../Relay";
	import type { RelayManager } from "../RelayManager";
	import type { SharedFolder, SharedFolders } from "../SharedFolder";
	import FolderSelectInput from "./FolderSelectInput.svelte";
	import SettingItem from "./SettingItem.svelte";
	import { Folder, FolderLock, FolderOpen, ArrowRight } from "lucide-svelte";
	import { writable } from "svelte/store";
	import { onMount, onDestroy } from "svelte";

	export let app: App;
	export let relay: Relay;
	export let relayManager: RelayManager;
	export let sharedFolders: SharedFolders;
	export let onConfirm: (
		folderPath: string,
		folderName: string,
		isPrivate: boolean,
		userIds: string[],
	) => Promise<SharedFolder>;

	let currentStep: "main" | "users" = "main";
	let isPrivate = false;
	let selectedFolderStore = writable<string | undefined>();
	let selectedUsers: Set<string> = new Set();

	$: selectedFolder = $selectedFolderStore || "";

	interface UserSelection {
		user: RelayUser;
		selected: boolean;
	}

	let users: UserSelection[] = [];
	let searchQuery = "";

	function setupUsers() {
		const relayRoles = relayManager.relayRoles
			.values()
			.filter((role) => role.relayId === relay.id);
		const availableUsers = relayRoles.map((role) => role.user);
		const currentUserId = relayManager.user?.id;

		// Filter out current user from the list
		users = availableUsers
			.filter((user) => user.id !== currentUserId)
			.map((user) => ({
				user,
				selected: false,
			}));

		// Initialize selectedUsers without current user
		selectedUsers = new Set();
	}

	$: if (currentStep === "users") {
		setupUsers();
	}

	$: filteredUsers = users.filter((userSelection) => {
		if (!searchQuery || searchQuery.trim() === "") return true;
		const query = searchQuery.toLowerCase().trim();
		return (
			userSelection.user.name.toLowerCase().includes(query) ||
			(userSelection.user.email && userSelection.user.email.toLowerCase().includes(query))
		);
	});

	$: sortedUsers = filteredUsers.sort((a, b) => {
		return a.user.name.localeCompare(b.user.name);
	});

	function clearSelectedFolder() {
		selectedFolderStore.set(undefined);
	}

	function handleMainNext() {
		if (isPrivate) {
			currentStep = "users";
		} else {
			handleShare();
		}
	}

	function toggleUser(userSelection: UserSelection) {
		userSelection.selected = !userSelection.selected;
		if (userSelection.selected) {
			selectedUsers.add(userSelection.user.id);
		} else {
			selectedUsers.delete(userSelection.user.id);
		}
		selectedUsers = new Set(selectedUsers);
		users = [...users];
	}

	async function handleShare() {
		// Filter out current user since their role is created automatically
		const currentUserId = relayManager.user?.id;
		const userIds = Array.from(selectedUsers).filter(id => id !== currentUserId);
		await onConfirm(
			selectedFolder,
			selectedFolder.split("/").pop() || "",
			isPrivate,
			userIds,
		);
	}

	function goBack() {
		currentStep = "main";
	}

	function getInitials(name: string): string {
		return name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.substring(0, 2);
	}

	let modalEl: HTMLElement;

	// Focus trap functionality
	onMount(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Tab") {
				trapFocus(e);
			}
		};

		document.addEventListener("keydown", handleKeyDown);

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	});

	function trapFocus(e: KeyboardEvent) {
		if (!modalEl) return;

		const focusableElements = modalEl.querySelectorAll(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		const firstFocusable = focusableElements[0] as HTMLElement;
		const lastFocusable = focusableElements[
			focusableElements.length - 1
		] as HTMLElement;

		if (e.shiftKey) {
			// Shift + Tab
			if (document.activeElement === firstFocusable) {
				e.preventDefault();
				lastFocusable.focus();
			}
		} else {
			// Tab
			if (document.activeElement === lastFocusable) {
				e.preventDefault();
				firstFocusable.focus();
			}
		}
	}
</script>

{#if currentStep === "main"}
	<div class="modal-title">Share Folder</div>

	<div class="modal-content share-folder-modal" bind:this={modalEl}>
		<div class="section">
			<h3>Folder</h3>
			{#if selectedFolder}
				<div class="folder-transformation">
					<div class="folder-state">
						<FolderOpen class="svg-icon folder-icon" />
						<span class="folder-name">{selectedFolder.split("/").pop() || selectedFolder}</span>
					</div>
					<ArrowRight class="svg-icon arrow-icon" />
					<div class="folder-state">
						{#if isPrivate}
							<FolderLock class="svg-icon folder-icon" />
						{:else}
							<Folder class="svg-icon folder-icon" />
						{/if}
						<span class="folder-name">{selectedFolder.split("/").pop() || selectedFolder}</span>
					</div>
					<button class="clear-button" on:click={clearSelectedFolder}>×</button>
				</div>
			{:else}
				<FolderSelectInput
					{app}
					{sharedFolders}
					selectedFolder={selectedFolderStore}
				/>
			{/if}
		</div>

		{#if relay.version > 0}
			<SettingItem name="Private" description="Only selected users can access this folder">
				<div
					role="checkbox"
					aria-checked={isPrivate}
					tabindex="0"
					on:keypress={() => isPrivate = !isPrivate}
					class="checkbox-container"
					class:is-enabled={isPrivate}
					on:click={() => isPrivate = !isPrivate}
				>
					<input
						type="checkbox"
						bind:checked={isPrivate}
						tabindex="-1"
					/>
					<div class="checkbox-toggle"></div>
				</div>
			</SettingItem>
		{/if}

		<div class="modal-button-container">
			<button
				class="mod-cta"
				disabled={!selectedFolder}
				on:click={handleMainNext}
			>
				{isPrivate ? "Add Users" : "Share"}
			</button>
		</div>
	</div>
{:else if currentStep === "users"}
	<div class="modal-title">Add Users to Folder</div>

	<div class="modal-content share-folder-modal" bind:this={modalEl}>
		<div class="section">
			<h3>Selected Folder</h3>
			<div class="folder-transformation readonly">
				<div class="folder-state">
					<FolderOpen class="svg-icon folder-icon" />
					<span class="folder-name">{selectedFolder.split("/").pop() || selectedFolder}</span>
				</div>
				<ArrowRight class="svg-icon arrow-icon" />
				<div class="folder-state">
					{#if isPrivate}
						<FolderLock class="svg-icon folder-icon" />
					{:else}
						<Folder class="svg-icon folder-icon" />
					{/if}
					<span class="folder-name">{selectedFolder.split("/").pop() || selectedFolder}</span>
				</div>
			</div>
		</div>

		<div class="section">
			<h3>Users</h3>
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
							on:click={() => toggleUser(userSelection)}
							role="button"
							tabindex="0"
							on:keydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									toggleUser(userSelection);
								}
							}}
						>
							<input
								type="checkbox"
								checked={userSelection.selected}
								class="user-checkbox"
								tabindex="-1"
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
								{#if userSelection.user.email}
									<div class="user-email">{userSelection.user.email}</div>
								{/if}
							</div>

						</div>
					{/each}
				{/if}
			</div>
		</div>

		<div class="modal-button-container users-step">
			<button class="mod-muted" on:click={goBack}>Back</button>
			<button
				class="mod-cta"
				disabled={false}
				on:click={handleShare}
			>
				Share
			</button>
		</div>
	</div>
{/if}

<style>
	.share-folder-modal {
		min-width: 500px;
		max-width: 600px;
	}

	.section {
		margin-bottom: 24px;
	}

	.section h3 {
		margin: 0 0 12px 0;
		font-size: 1.1em;
		font-weight: 600;
		color: var(--text-normal);
	}

	.folder-transformation {
		display: flex;
		align-items: center;
		padding: 8px 12px;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		gap: 8px;
	}

	.folder-transformation.readonly {
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
	}

	.folder-state {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.folder-name {
		font-weight: 500;
		color: var(--text-normal);
		white-space: nowrap;
	}

	.clear-button {
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 16px;
		padding: 0;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 2px;
		margin-left: auto;
	}

	.clear-button:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}


	.search-container {
		margin-bottom: 12px;
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
		max-height: 300px;
		overflow-y: auto;
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		background: var(--background-primary);
	}

	.user-item {
		display: flex;
		align-items: center;
		padding: 12px;
		border-bottom: 1px solid var(--background-modifier-border);
		gap: 12px;
	}

	.user-item:last-child {
		border-bottom: none;
	}

	.user-item:hover {
		background: var(--background-modifier-hover);
	}

	.user-item:focus {
		outline: 2px solid var(--interactive-accent);
		outline-offset: -2px;
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


	.no-users {
		text-align: center;
		padding: 40px;
		color: var(--text-muted);
	}

	.modal-button-container {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		margin-top: 24px;
		gap: 12px;
	}

	.modal-button-container.users-step {
		justify-content: space-between;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.checkbox-container {
		cursor: pointer;
	}
</style>
