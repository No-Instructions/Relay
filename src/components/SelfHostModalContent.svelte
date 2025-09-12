<script lang="ts">
	import { Notice } from "obsidian";
	import type { RelayManager } from "../RelayManager";
	import type { Provider, Organization } from "../Relay";
	import Avatar from "./Avatar.svelte";
	
	export let onConfirm: (url?: string, providerId?: string, organizationId?: string) => Promise<void>;
	export let onCancel: () => void;
	export let relayManager: RelayManager;

	let url = "";
	let isCreating = false;
	let errors: { url?: string } = {};
	let selectedProvider: Provider | null = null;
	let showNewProviderForm = false;
	let showOwnerDropdown = false;
	
	type Owner = { type: 'user', user: typeof relayManager.user } | { type: 'org', org: Organization };
	let selectedOwner: Owner | null = null;
	
	// Get existing self-hosted providers
	$: providers = relayManager.providers ? Array.from(relayManager.providers.values()).filter(p => p.selfHosted) : [];
	
	// Get organizations where user has owner role
	$: organizations = relayManager.organizationRoles ? 
		Array.from(relayManager.organizationRoles.values())
			.filter(role => role.role === "Owner")
			.map(role => role.organization) : [];
	
	// Initialize with current user as owner
	$: if (!selectedOwner && relayManager.user) {
		selectedOwner = { type: 'user', user: relayManager.user };
	}

	// Validate URL as user types
	$: {
		if (url.trim()) {
			const urlError = validateUrl(url);
			if (urlError) {
				errors.url = urlError;
			} else if (errors.url) {
				delete errors.url;
				errors = errors;
			}
		} else if (errors.url) {
			delete errors.url;
			errors = errors;
		}
	}


	function validateUrl(value: string): string | undefined {
		if (!value.trim()) {
			return "URL is required";
		}
		try {
			const parsedUrl = new URL(value);
			if (!["http:", "https:"].includes(parsedUrl.protocol)) {
				return "URL must use http or https protocol";
			}
			return undefined;
		} catch {
			return "Please enter a valid URL";
		}
	}

	function validateForm(): boolean {
		errors = {};
		
		const urlError = validateUrl(url);
		if (urlError) {
			errors.url = urlError;
		}

		return Object.keys(errors).length === 0;
	}

	function selectProvider(provider: Provider) {
		selectedProvider = provider;
		showNewProviderForm = false;
	}

	function showNewForm() {
		selectedProvider = null;
		showNewProviderForm = true;
		// Reset form
		url = "";
		errors = {};
	}

	async function handleSubmit() {
		const organizationId = selectedOwner?.type === 'org' ? selectedOwner.org.id : undefined;
		
		if (selectedProvider) {
			// Creating relay with existing provider
			isCreating = true;
			try {
				await onConfirm(undefined, selectedProvider.id, organizationId);
				new Notice("Self-hosted relay created successfully!");
			} catch (error) {
				console.error("Failed to create self-hosted relay:", error);
				new Notice(
					error instanceof Error 
						? `Failed to create relay: ${error.message}` 
						: "Failed to create relay: Unknown error"
				);
			} finally {
				isCreating = false;
			}
		} else {
			// Creating new provider - need URL
			if (!validateForm() || isCreating) {
				return;
			}

			isCreating = true;

			try {
				await onConfirm(url.trim(), undefined, organizationId);
				new Notice("Self-hosted relay created successfully!");
			} catch (error) {
				console.error("Failed to create self-hosted relay:", error);
				new Notice(
					error instanceof Error 
						? `Failed to create relay: ${error.message}` 
						: "Failed to create relay: Unknown error"
				);
			} finally {
				isCreating = false;
			}
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			handleSubmit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
		}
	}
	
	function selectOwner(owner: Owner) {
		selectedOwner = owner;
		showOwnerDropdown = false;
	}
	
	function toggleOwnerDropdown(e: MouseEvent) {
		e.stopPropagation();
		showOwnerDropdown = !showOwnerDropdown;
	}
	
	function handleClickOutside(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('.owner-selector')) {
			showOwnerDropdown = false;
		}
	}
</script>

<svelte:window on:click={handleClickOutside} />

<div class="self-host-modal">
	<div class="setting-item-description" style="margin-bottom: 16px;">
		<p>Create a new self-hosted Relay Server. Select an existing host or add a new one.</p>
	</div>

	<!-- Owner Selector -->
	<div class="owner-section">
		<div class="setting-item-name">Owner</div>
		<div class="owner-selector">
			<button 
				class="owner-display"
				on:click={toggleOwnerDropdown}
				type="button"
			>
				{#if selectedOwner}
					<div class="owner-item">
						{#if selectedOwner.type === 'user' && selectedOwner.user}
							<Avatar user={selectedOwner.user} size="24px" />
							<span class="owner-name">{selectedOwner.user.name} (Personal)</span>
						{:else if selectedOwner.type === 'org'}
							<div class="org-avatar">
								<span>{selectedOwner.org.name.charAt(0).toUpperCase()}</span>
							</div>
							<span class="owner-name">{selectedOwner.org.name}</span>
						{/if}
					</div>
				{/if}
				<svg class="dropdown-arrow" width="8" height="8" viewBox="0 0 8 8">
					<path d="M0 2 L4 6 L8 2" stroke="currentColor" stroke-width="1.5" fill="none"/>
				</svg>
			</button>
			
			{#if showOwnerDropdown}
				<div class="owner-dropdown">
					{#if relayManager.user}
						<button 
							class="owner-option"
							class:selected={selectedOwner?.type === 'user'}
							on:click={() => selectOwner({ type: 'user', user: relayManager.user })}
							type="button"
						>
							<Avatar user={relayManager.user} size="24px" />
							<span class="owner-name">{relayManager.user.name} (Personal)</span>
						</button>
					{/if}
					
					{#if organizations.length > 0}
						<div class="dropdown-separator"></div>
						<div class="dropdown-label">Organizations</div>
						{#each organizations as org}
							<button 
								class="owner-option"
								class:selected={selectedOwner?.type === 'org' && selectedOwner.org.id === org.id}
								on:click={() => selectOwner({ type: 'org', org })}
								type="button"
							>
								<div class="org-avatar">
									<span>{org.name.charAt(0).toUpperCase()}</span>
								</div>
								<span class="owner-name">{org.name}</span>
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- Host List -->
	{#if providers.length > 0}
		<div class="host-list-section">
			<div class="setting-item-name">Hosts</div>
			<div class="host-list">
				{#each providers as provider (provider.id)}
					<div 
						class="host-card" 
						class:active={selectedProvider?.id === provider.id}
						on:click={() => selectProvider(provider)}
						on:keydown={(e) => e.key === 'Enter' || e.key === ' ' ? selectProvider(provider) : null}
						role="button"
						tabindex="0"
						title="Click to select this host"
					>
						<div class="host-info">
							<div class="host-url">{provider.url}</div>
							{#if provider.publicKey}
								<div class="host-key-indicator">Public key configured</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Add New Host -->
	<div class="host-list-section">
		<div class="setting-item-name">Add Host</div>
		<div class="host-list">
			<div class="host-card add-host-card">
				<div class="host-info">
					<input 
						type="url" 
						placeholder="https://relay.mycompany.com"
						bind:value={url}
						class="host-url-input"
						class:host-input-invalid={errors.url}
						title={errors.url}
					/>
				</div>
			</div>
		</div>
	</div>

	<!-- Action Button -->
	<div class="modal-button-container">
		<button 
			class="mod-cta"
			on:click={handleSubmit}
			disabled={isCreating || (!selectedProvider && (!url.trim() || !!errors.url))}
		>
			{#if isCreating}
				Creating...
			{:else}
				Create Relay Server
			{/if}
		</button>
	</div>
</div>

<style>
	.self-host-modal {
		padding: 0 0 20px 0;
	}

	/* Owner Selector Styles */
	.owner-section {
		margin: 16px 0 24px 0;
	}

	.owner-selector {
		position: relative;
		margin-top: 8px;
	}

	.owner-display {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		background: var(--background-primary);
		cursor: pointer;
		transition: all 0.2s ease;
		text-align: left;
		color: var(--text-normal);
	}

	.owner-display:hover {
		background: var(--background-modifier-hover);
		border-color: var(--interactive-accent);
	}

	.owner-item {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.owner-name {
		font-size: 0.9em;
		color: var(--text-normal);
	}

	.dropdown-arrow {
		transition: transform 0.2s ease;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.owner-display:hover .dropdown-arrow {
		color: var(--text-normal);
	}

	.owner-dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		background: var(--background-primary);
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		box-shadow: var(--shadow-s);
		z-index: 1000;
		max-height: 300px;
		overflow-y: auto;
	}

	.owner-option {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border: none;
		background: transparent;
		cursor: pointer;
		transition: background 0.2s ease;
		text-align: left;
		color: var(--text-normal);
	}

	.owner-option:hover {
		background: var(--background-modifier-hover);
	}

	.owner-option.selected {
		background: var(--background-modifier-hover);
	}

	.dropdown-separator {
		height: 1px;
		background: var(--background-modifier-border);
		margin: 4px 0;
	}

	.dropdown-label {
		padding: 4px 12px;
		font-size: 0.8em;
		color: var(--text-muted);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.org-avatar {
		width: 24px;
		height: 24px;
		border-radius: 4px;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 600;
	}




	.host-list-section {
		margin: 16px 0;
	}

	.host-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 8px;
	}

	.host-card {
		display: flex;
		align-items: center;
		padding: 12px;
		margin: 8px 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		background: var(--background-primary);
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.host-card:hover {
		background: var(--background-modifier-hover);
	}

	.host-card.active {
		border-color: var(--interactive-accent);
		background: var(--background-modifier-hover);
	}

	.host-info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
	}

	.host-url {
		font-size: 0.85em;
		color: var(--text-muted);
		font-family: var(--font-monospace);
	}

	.host-key-indicator {
		font-size: 0.8em;
		color: var(--text-faint);
	}

	.add-host-card {
		border-style: dashed;
		opacity: 0.8;
	}

	.add-host-card:hover {
		opacity: 1;
	}

	.host-url-input {
		width: 100%;
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-size: 0.85em;
		font-family: var(--font-monospace);
		padding: 0;
		outline: none;
	}

	.host-url-input:focus {
		color: var(--text-normal);
	}

	.host-url-input::placeholder {
		color: var(--text-faint);
		opacity: 0.8;
	}

	.host-input-invalid {
		color: var(--text-error) !important;
	}

	.modal-button-container {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		margin-top: 24px;
		gap: 12px;
	}


	button {
		padding: 8px 16px;
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		background-color: var(--background-primary);
		color: var(--text-normal);
		cursor: pointer;
		font-size: 14px;
	}

	button:hover {
		background-color: var(--background-modifier-hover);
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	button:disabled:hover {
		background-color: var(--background-primary);
	}

	button.mod-cta {
		background-color: var(--interactive-accent);
		color: var(--text-on-accent);
		border-color: var(--interactive-accent);
	}

	button.mod-cta:hover:not(:disabled) {
		background-color: var(--interactive-accent-hover);
	}
</style>
