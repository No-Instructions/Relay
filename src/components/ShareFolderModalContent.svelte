<script lang="ts">
	import type { App } from "obsidian";
	import { Platform } from "obsidian";
	import type { Relay, RelayUser, Role, UserRoleGrant } from "../Relay";
	import type { RelayManager } from "../RelayManager";
	import type { SharedFolder, SharedFolders } from "../SharedFolder";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import SlimSettingItem from "./SlimSettingItem.svelte";
	import SelectedFolder from "./SelectedFolder.svelte";
	import TFolderSuggest from "./TFolderSuggest.svelte";
	import RoleSelect from "./RoleSelect.svelte";
	import { onMount, onDestroy } from "svelte";
	import { derived, writable } from "svelte/store";
	import { FolderSuggestModal } from "../ui/FolderSuggestModal";
	import { handleServerError } from "src/utils/toastStore";
	import { flags } from "src/flagManager";

	export let app: App;
	export let relay: Relay;
	export let relayManager: RelayManager;
	export let sharedFolders: SharedFolders;
	export let onConfirm: (
		folderPath: string,
		folderName: string,
		isPrivate: boolean,
		grants: UserRoleGrant[],
	) => Promise<SharedFolder>;
	export let setTitle: (title: string) => void = () => {};

	let currentStep: "main" | "users" = "main";
	let isPrivate = false;
	let inputValue = "";
	let acceptedFolder = "";
	let sharing = false;
	const readOnlyPermissionsEnabled = flags().enableReadOnlyPermissions;

	// Obsidian's mobile clients have no room for the desktop suggest overlay,
	// which hides the platform modal and mounts an unpositioned prompt. Mobile
	// picks the folder through an inline suggest that stays inside this modal.
	const isMobile = Platform?.isMobile ?? false;

	// Selected users with the role each will be granted.
	const initialSelectedUsers = new Map<string, Role>();
	if (relayManager.user?.id) {
		initialSelectedUsers.set(relayManager.user.id, "Member");
	}
	const selectedUsers = writable(initialSelectedUsers);
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
		role: Role;
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
					role: $selectedUsers.get(user.id) ?? "Member",
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

	async function handleMainNext() {
		if (sharing) return;
		// If user typed but didn't accept via enter/tab, accept the current input
		if (!acceptedFolder && inputValue.trim()) {
			acceptedFolder = inputValue.trim();
		}

		if (isPrivate) {
			currentStep = "users";
			setTitle("Add Users to Folder");
		} else {
			await handleShare();
		}
	}

	function toggleUser(userSelection: UserSelection) {
		if (userSelection.isCurrentUser) return;

		selectedUsers.update(current => {
			const newMap = new Map(current);
			if (newMap.has(userSelection.user.id)) {
				newMap.delete(userSelection.user.id);
			} else {
				newMap.set(userSelection.user.id, "Member");
			}
			return newMap;
		});
	}

	function setUserRole(userId: string, role: Role) {
		selectedUsers.update(current => {
			const newMap = new Map(current);
			if (newMap.has(userId)) {
				newMap.set(userId, role);
			}
			return newMap;
		});
	}

	async function handleShare() {
		if (sharing) return;
		// If user typed but didn't accept via enter/tab, accept the current input
		if (!acceptedFolder && inputValue.trim()) {
			acceptedFolder = inputValue.trim();
		}

		sharing = true;
		try {
			// Filter out current user since their role is created automatically
			const currentUserId = relayManager.user?.id;
			const grants: UserRoleGrant[] = Array.from(
				$selectedUsers.entries(),
			)
				.filter(([userId]) => userId !== currentUserId)
				.map(([userId, role]) => ({ userId, role }));
			await onConfirm(
				acceptedFolder,
				acceptedFolder.split("/").pop() || "",
				isPrivate,
				grants,
			);
		} catch (error) {
			handleServerError(error, "Failed to share folder.");
		} finally {
			sharing = false;
		}
	}

	function goBack() {
		currentStep = "main";
		setTitle("Share local folder");
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

		// Desktop auto-opens the suggest overlay; mobile shows the inline picker.
		if (!isMobile && !acceptedFolder) {
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
	<div class="share-folder-modal" bind:this={modalEl}>
		<div class="section">
			<SettingItemHeading name="Folder" />
			{#if isMobile && !acceptedFolder}
				<TFolderSuggest
					{app}
					placeholder="Choose or create folder..."
					blockedPaths={getBlockedPaths()}
					on:select={(e) => handleFolderSelect(e.detail.value)}
				/>
			{:else}
				<SelectedFolder
					selectedItem={acceptedFolder}
					showTransformation={true}
					{isPrivate}
					selectButtonText="Choose or create folder..."
					on:clear={clearSelectedFolder}
					on:select={openFolderSuggest}
				/>
			{/if}
		</div>

		{#if relay.version > 0}
			<SlimSettingItem
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
			</SlimSettingItem>
		{/if}

		<SlimSettingItem name="">
			<button
				class="mod-cta"
				disabled={sharing || (!acceptedFolder && !inputValue.trim())}
				aria-busy={sharing}
				on:click={handleMainNext}
			>
				{isPrivate ? "Add Users" : "Share"}
			</button>
		</SlimSettingItem>
	</div>
{:else if currentStep === "users"}
	<div class="share-folder-modal" bind:this={modalEl}>
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
							{:else if userSelection.selected && readOnlyPermissionsEnabled}
								<RoleSelect
									{relayManager}
									value={userSelection.role}
									onChange={(role) =>
										setUserRole(userSelection.user.id, role)}
								/>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<div class="modal-button-container users-step">
			<button class="mod-muted" disabled={sharing} on:click={goBack}>Back</button>
			<button
				class="mod-cta"
				disabled={sharing}
				aria-busy={sharing}
				on:click={handleShare}
			>
				Share
			</button>
		</div>
	</div>
{/if}

<style>
	.share-folder-modal {
		display: flex;
		flex-direction: column;
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
		flex-direction: row;
		justify-content: flex-end;
		align-items: center;
		margin-top: auto;
		padding-top: 24px;
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
		background-color: var(--background-modifier-border);
	}

	.checkbox-container.is-enabled {
		background-color: var(--interactive-accent);
	}
</style>
