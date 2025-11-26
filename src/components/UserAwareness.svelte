<script lang="ts">
	import Avatar from "./Avatar.svelte";
	import { onDestroy, onMount } from "svelte";
	import type { Awareness } from "y-protocols/awareness.js";
	import type { RelayUser } from "../Relay";
	import { derived, writable } from "svelte/store";

	export let awareness: Awareness;
	export let relayUsers: any;

	let showPopover = false;
	let popoverElement: HTMLElement;
	let avatarStackElement: HTMLElement;

	interface AwarenessUserData {
		name: string;
		id: string;
		color: string;
		colorLight: string;
		relayUser?: RelayUser;
	}

	const VISIBLE_AVATAR_COUNT = 4;

	// Create a writable store to trigger updates when awareness changes
	const awarenessUpdate = writable(0);

	// Subscribe to awareness changes to trigger store updates
	let cleanupFunction: (() => void) | null = null;

	$: if (awareness) {
		// Clean up previous listener if any
		if (cleanupFunction) {
			cleanupFunction();
		}

		const handleChange = () => {
			awarenessUpdate.update((n) => n + 1);
		};

		awareness.on("change", handleChange);
		awarenessUpdate.set(0); // Initial trigger

		// Store cleanup function
		cleanupFunction = () => {
			awareness.off("change", handleChange);
		};
	}

	// Create derived store that combines awareness states with relay users
	const allUsers = derived(
		[relayUsers, awarenessUpdate],
		([$relayUsers, _]) => {
			if (!awareness || !$relayUsers) {
				return [];
			}

			const states = awareness.getStates();
			const users: AwarenessUserData[] = [];

			states.forEach((state, clientId) => {
				// Include all users (both local and remote)
				const user = state.user;
				if (user && user.name && user.id) {
					// Try to look up the full RelayUser from the users store
					const relayUser = $relayUsers.get(user.id);

					users.push({
						name: user.name,
						id: user.id,
						color: user.color || "#30bced",
						colorLight: user.colorLight || user.color + "33" || "#30bced33",
						relayUser: relayUser,
					});
				}
			});

			// Remove duplicates by id (in case same user has multiple clients)
			const uniqueUsers = users.filter(
				(user, index, arr) => arr.findIndex((u) => u.id === user.id) === index,
			);

			// Sort users so current user appears first, then users with avatars
			const sortedUsers = uniqueUsers.sort((a, b) => {
				const localState = awareness.getLocalState();
				const localUserId = localState?.user?.id;
				
				// Current user always first
				if (a.id === localUserId) return -1;
				if (b.id === localUserId) return 1;
				
				// Then prefer users with avatars (relayUser)
				if (a.relayUser && !b.relayUser) return -1;
				if (!a.relayUser && b.relayUser) return 1;
				
				return 0;
			});

			return [...sortedUsers];
		},
	);

	// Arrange users for display: current user at the end, others before
	const displayUsers = derived([allUsers], ([$allUsers]) => {
		if ($allUsers.length === 0) return [];

		const localState = awareness?.getLocalState();
		const localUserId = localState?.user?.id;

		// Find current user and other users
		const currentUser = $allUsers.find((user) => user.id === localUserId);
		const otherUsers = $allUsers.filter((user) => user.id !== localUserId);

		// Always put current user at the end, regardless of total count
		if (currentUser) {
			if ($allUsers.length <= VISIBLE_AVATAR_COUNT) {
				// Show all other users first, then current user
				return [...otherUsers, currentUser];
			} else {
				// Show limited other users first, then current user at the end
				const visibleOthers = otherUsers.slice(0, VISIBLE_AVATAR_COUNT - 1);
				return [...visibleOthers, currentUser];
			}
		} else {
			// No current user found, just show other users
			return otherUsers.slice(0, VISIBLE_AVATAR_COUNT);
		}
	});

	function togglePopover() {
		showPopover = !showPopover;
	}

	function handleClickOutside(event: MouseEvent) {
		if (popoverElement && !popoverElement.contains(event.target as Node)) {
			showPopover = false;
		}
	}

	// Calculate spacing for each avatar (CSS handles hover behavior)
	function getAvatarSpacing(index: number): string {
		return index === 0
			? "0"
			: index === 1
				? "-1em"
				: index === 2
					? "-1.4em"
					: "-1.8em";
	}

	onMount(() => {
		document.addEventListener("click", handleClickOutside);
		return () => {
			document.removeEventListener("click", handleClickOutside);
		};
	});

	// Cleanup on component destroy
	onDestroy(() => {
		if (cleanupFunction) {
			cleanupFunction();
		}
		document.removeEventListener("click", handleClickOutside);
	});
</script>

{#if $allUsers.length > 0}
	<div class="user-awareness" bind:this={popoverElement}>
		<!-- Stacked avatars -->
		<div
			class="avatar-stack"
			class:multi-user={$displayUsers.length > 1}
			bind:this={avatarStackElement}
			on:click={togglePopover}
			on:keydown={(e) => e.key === "Enter" && togglePopover()}
			role="button"
			tabindex="0"
		>
			{#each $displayUsers as user, index (user.id)}
				<div
					class="stacked-avatar"
					style="z-index: {10 - index}; margin-left: {getAvatarSpacing(
						index,
					)}; transition: all 0.2s ease;"
					aria-label={user.name}
				>
					{#if user.relayUser}
						<div class="avatar-with-border" style="border-color: {user.color};">
							<Avatar user={user.relayUser} size="2em" alt={user.name} />
						</div>
					{:else}
						<div class="avatar-with-border" style="border-color: {user.color};">
							<div class="user-avatar" style="background-color: {user.color};">
								<span class="user-initial">
									{user.name.charAt(0).toUpperCase()}
								</span>
							</div>
						</div>
					{/if}
				</div>
			{/each}
			{#if $allUsers.length > VISIBLE_AVATAR_COUNT}
				<div
					class="more-indicator"
					style="z-index: 11; margin-top: 1em; margin-left: -1em; transition: all 0.2s ease;"
				>
					+{$allUsers.length - VISIBLE_AVATAR_COUNT}
				</div>
			{/if}
		</div>

		<!-- Popover -->
		{#if showPopover}
			<div class="user-popover">
				<div class="popover-header">
					Active Users ({$allUsers.length})
				</div>
				<div class="user-list">
					{#each $allUsers as user, index (user.id)}
						<div class="user-item" class:current-user={index === 0}>
							{#if user.relayUser}
								<div
									class="avatar-with-border"
									style="border-color: {user.color};"
								>
									<Avatar user={user.relayUser} size="20px" alt={user.name} />
								</div>
							{:else}
								<div
									class="avatar-with-border"
									style="border-color: {user.color};"
								>
									<div
										class="user-avatar"
										style="background-color: {user.color}; width: 20px; height: 20px;"
									>
										<span class="user-initial">
											{user.name.charAt(0).toUpperCase()}
										</span>
									</div>
								</div>
							{/if}
							<span class="user-name"
								>{user.name}{index === 0 ? " (You)" : ""}</span
							>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	:global(.user-awareness-container) {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		margin-left: 12px;
		position: relative;
	}

	.user-awareness {
		position: relative;
		display: flex;
		align-items: center;
	}

	.avatar-stack {
		display: flex;
		align-items: center;
		cursor: pointer;
		position: relative;
		transition: width 0.2s ease;
		overflow: visible;
	}

	.stacked-avatar {
		position: relative;
	}

	.avatar-stack.multi-user .stacked-avatar {
		transition: margin-left 0.2s ease;
	}

	/* Only enable hover expand on devices with hover capability (non-touch) */
	@media (hover: hover) and (pointer: fine) {
		.avatar-stack.multi-user:hover .stacked-avatar {
			margin-left: -10px !important;
			margin-right: 2px;
			transition-delay: 300ms;
		}
	}

	.more-indicator {
		width: 2em;
		height: 2em;
		border-radius: 50%;
		background-color: var(--background-modifier-border);
		border: 2px solid var(--text-muted);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.6em;
		font-weight: 600;
		color: var(--text-muted);
		position: relative;
	}

	.user-popover {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 8px;
		background: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		box-shadow: var(--shadow-s);
		min-width: 200px;
		max-width: 300px;
		z-index: 1000;
	}

	.user-popover::before {
		content: "";
		position: absolute;
		top: -8px;
		right: 20px;
		width: 0;
		height: 0;
		border-left: 8px solid transparent;
		border-right: 8px solid transparent;
		border-bottom: 8px solid var(--background-modifier-border);
	}

	.user-popover::after {
		content: "";
		position: absolute;
		top: -7px;
		right: 20px;
		width: 0;
		height: 0;
		border-left: 8px solid transparent;
		border-right: 8px solid transparent;
		border-bottom: 8px solid var(--background-secondary);
	}

	.popover-header {
		padding: 12px 16px 8px 16px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		border-bottom: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		border-radius: 8px 8px 0 0;
	}

	.user-list {
		padding: 8px 0;
		max-height: 200px;
		overflow-y: auto;
	}

	.user-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 16px;
		cursor: default;
	}

	.user-item:hover {
		background-color: var(--background-modifier-hover);
	}

	.user-name {
		font-size: 14px;
		color: var(--text-normal);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.avatar-with-border {
		border-radius: 50%;
		border: 2px solid;
		display: inline-block;
		overflow: hidden;
		flex-shrink: 0;
		background: var(--background-primary);
		box-sizing: border-box;
		padding: 1px;
	}

	.user-avatar {
		width: 2em;
		height: 2em;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		position: relative;
	}

	.user-initial {
		color: white;
		font-size: 1em;
		font-weight: 600;
	}
</style>
