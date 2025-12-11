<script lang="ts">
	import type { App } from "obsidian";
	import type { Relay, RelayUser, Role } from "../Relay";
	import type { RelayManager } from "../RelayManager";
	import type { SharedFolder, SharedFolders } from "../SharedFolder";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SettingGroup from "./SettingGroup.svelte";
	import SelectedFolder from "./SelectedFolder.svelte";
	import { onMount, onDestroy } from "svelte";
	import { derived, writable } from "svelte/store";
	import { FolderSuggestModal } from "../ui/FolderSuggestModal";
	import { handleServerError } from "src/utils/toastStore";

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
	let inputValue = "";
	let acceptedFolder = "";
	
	const selectedUsers = writable(new Set<string>(relayManager.user?.id ? [relayManager.user.id] : []));
	const searchQuery = writable("");

	let modalEl: HTMLElement;

	const getBlockedPaths = () => {
		return new Set<string>(
			sharedFolders
				.filter((folder) => !!folder.relayId)
				.map((folder) => folder.path),
		).add("/");
	};

	interface UserSelection {
		user: RelayUser;
		selected: boolean;
		isCurrentUser: boolean;
	}

	// Create derived store for users in this relay
	const relayUsers = derived(
		[relayManager.relayRoles],
		([$relayRoles]) => {
			return Array.from($relayRoles.values())
				.filter((role) => role.relayId === relay.id)
				.map((role) => role.user);
		}
	);

	// Create derived store for user selections
	const users = derived(
		[relayUsers, selectedUsers],
		([$relayUsers, $selectedUsers]) => {
			const currentUserId = relayManager.user?.id;
			return $relayUsers.map((user) => {
				const isCurrentUser = currentUserId === user.id;
				const selected = $selectedUsers.has(user.id) || isCurrentUser;
				return {
					user,
					selected,
					isCurrentUser,
				};
			});
		}
	);

	const filteredUsers = derived(
		[users, searchQuery],
		([$users, $searchQuery]) => {
			if (!$searchQuery || $searchQuery.trim() === "") return $users;
			const query = $searchQuery.toLowerCase().trim();
			return $users.filter((userSelection) =>
				userSelection.user.name.toLowerCase().includes(query)
			);
		}
	);

	const sortedUsers = derived(
		[filteredUsers],
		([$filteredUsers]) => {
			return $filteredUsers.sort((a, b) => {
				return a.user.name.localeCompare(b.user.name);
			});
		}
	);

	function clearSelectedFolder() {
		acceptedFolder = "";
		inputValue = "";
		// Clear the folder name since it's derived from the selected folder
		// This will reset to empty since there's no selected folder
	}

	function handleMainNext() {
		// If user typed but didn't accept via enter/tab, accept the current input
		if (!acceptedFolder && inputValue.trim()) {
			acceptedFolder = inputValue.trim();
		}

		if (isPrivate) {
			currentStep = "users";
		} else {
			handleShare();
		}
	}

	function toggleUser(userSelection: UserSelection) {
		if (userSelection.isCurrentUser) return;

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

	async function handleShare() {
		// If user typed but didn't accept via enter/tab, accept the current input
		if (!acceptedFolder && inputValue.trim()) {
			acceptedFolder = inputValue.trim();
		}

		try {
			// Filter out current user since their role is created automatically
			const currentUserId = relayManager.user?.id;
			const currentSelectedUsers = $selectedUsers;
			const userIds = Array.from(currentSelectedUsers).filter(
				(id) => id !== currentUserId,
			);
			await onConfirm(
				acceptedFolder,
				acceptedFolder.split("/").pop() || "",
				isPrivate,
				userIds,
			);
		} catch (error) {
			handleServerError(error, "Failed to share folder.");
		}
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

	function handleFolderSelect(folderPath: string) {
		acceptedFolder = folderPath;
		inputValue = folderPath;
	}

	function openFolderSuggest() {
		const modal = new FolderSuggestModal(
			app,
			"Choose or create folder...",
			getBlockedPaths(),
			sharedFolders,
			handleFolderSelect,
		);
		modal.open();
	}

	const handleGlobalKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Tab") {
			trapFocus(e);
		}
	};

	// Focus trap functionality
	onMount(() => {
		document.addEventListener("keydown", handleGlobalKeyDown);

		// Auto-open folder selection prompt if no folder is selected
		if (!acceptedFolder) {
			setTimeout(() => {
				openFolderSuggest();
			}, 100);
		}

		return () => {
			document.removeEventListener("keydown", handleGlobalKeyDown);
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
	<div class="modal-title">Share a folder</div>

	<div class="modal-content share-folder-modal" bind:this={modalEl}>
		<div class="section">
			<SettingItemHeading name="Folder" />
			<SelectedFolder
				selectedItem={acceptedFolder}
				showTransformation={true}
				{isPrivate}
				selectButtonText="Choose or create folder..."
				on:clear={clearSelectedFolder}
				on:select={openFolderSuggest}
			/>
		</div>

		{#if relay.version > 0}
			<SettingItem
				name="Private"
				description="Only selected users can access this folder"
			>
				<div
					role="checkbox"
					aria-checked={isPrivate}
					tabindex="0"
					on:keypress={() => (isPrivate = !isPrivate)}
					class="checkbox-container"
					class:is-enabled={isPrivate}
					on:click={() => (isPrivate = !isPrivate)}
				>
					<input type="checkbox" bind:checked={isPrivate} tabindex="-1" />
					<div class="checkbox-toggle"></div>
				</div>
			</SettingItem>
		{/if}

		<div class="modal-button-container">
			<button
				class="mod-cta"
				disabled={!acceptedFolder && !inputValue.trim()}
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
			<SettingItemHeading name="Selected Folder" />
			<SelectedFolder
				selectedItem={acceptedFolder}
				showTransformation={true}
				{isPrivate}
				readonly={true}
			/>
		</div>

		<div class="section">
			<SettingItemHeading name="Users" />
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
							class:is-current-user={userSelection.isCurrentUser}
							on:click={() => toggleUser(userSelection)}
							role="button"
							tabindex="0"
							on:keydown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									toggleUser(userSelection);
								}
							}}
						>
							<input
								type="checkbox"
								checked={userSelection.selected}
								disabled={userSelection.isCurrentUser}
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
							</div>
							{#if userSelection.isCurrentUser}
								<div class="user-status">Required (You)</div>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<div class="modal-button-container users-step">
			<button class="mod-muted" on:click={goBack}>Back</button>
			<button class="mod-cta" disabled={false} on:click={handleShare}>
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

	/* Mobile responsive styles */
	@media (max-width: 768px) {
		.share-folder-modal {
			min-width: 100vw;
			max-width: 100vw;
			margin: 0;
			border-radius: 0;
			height: 100vh;
			max-height: 100vh;
		}
	}

	.section {
		margin-bottom: 24px;
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

	.user-item:hover:not(.is-current-user) {
		background: var(--background-modifier-hover);
	}

	.user-item.is-current-user {
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
		margin-left: auto;
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
