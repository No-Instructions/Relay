<script lang="ts">
	import type { RelayManager } from "../RelayManager";
	import type { Provider, Organization } from "../Relay";
	import SettingItem from "./SettingItem.svelte";
	import RelayConfigBlock from "./RelayConfigBlock.svelte";
	import { onMount } from "svelte";
	import { writable } from "svelte/store";
	import { customFetch } from "../customFetch";

	export let onConfirm: (
		url?: string,
		providerId?: string,
		organizationId?: string,
	) => Promise<void>;
	export let relayManager: RelayManager;

	let url = "";
	let isCreating = false;
	let errors: { url?: string; submit?: string } = {};
	const selectedProvider = writable<Provider | null>(null);
	let urlValidationTimeout: number | null = null;
	let hasStartedTyping = false;
	let loadingConfig = false;
	let configError: string | null = null;
	let configToml = "";
	let configTemplate = ""; // Store the template separately

	type Owner =
		| { type: "user"; user: typeof relayManager.user }
		| { type: "org"; org: Organization };
	let selectedOwner: Owner | null = null;

	// Get existing self-hosted providers
	$: providers = relayManager.providers;

	// Get organizations where user has owner role
	$: organizations = []; // TODO
	// relayManager.organizationRoles ?
	// 	Array.from(relayManager.organizationRoles.values())
	// 		.filter(role => role.role === "Owner")
	// 		.map(role => role.organization) : [];

	// Initialize with current user as owner
	$: if (!selectedOwner && relayManager.user) {
		selectedOwner = { type: "user", user: relayManager.user };
	}

	// Calculate total available options (user + organizations)
	$: totalOwnerOptions = (relayManager.user ? 1 : 0) + organizations.length;

	// Validate URL as user types with debounce
	$: {
		if (url.trim()) {
			hasStartedTyping = true;

			// Clear any existing timeout
			if (urlValidationTimeout) {
				clearTimeout(urlValidationTimeout);
			}

			// Set a new timeout to validate after user stops typing
			urlValidationTimeout = setTimeout(() => {
				const urlError = validateUrl(url);
				if (urlError) {
					errors.url = urlError;
				} else if (errors.url) {
					delete errors.url;
					errors = errors;
				}
			}, 500) as unknown as number; // 500ms delay
		} else {
			// Clear error when URL is empty
			if (errors.url) {
				delete errors.url;
				errors = errors;
			}
			hasStartedTyping = false;
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

	function selectProvider(provider: Provider | null) {
		selectedProvider.set(provider);
	}

	function showNewForm() {
		selectedProvider.set(null);
		// Reset form
		url = "";
		errors = {};
	}

	async function handleSubmit() {
		// Clear previous submit errors
		if (errors.submit) {
			delete errors.submit;
			errors = errors;
		}

		const organizationId =
			selectedOwner?.type === "org" ? selectedOwner.org.id : undefined;

		if ($selectedProvider) {
			// Creating relay with existing provider
			isCreating = true;
			try {
				await onConfirm(undefined, $selectedProvider.id, organizationId);
			} catch (error) {
				errors.submit =
					error instanceof Error
						? error.message
						: "Failed to create relay: Unknown error";
				errors = errors;
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
			} catch (error) {
				errors.submit =
					error instanceof Error
						? error.message
						: "Failed to create relay: Unknown error";
				errors = errors;
			} finally {
				isCreating = false;
			}
		}
	}

	function handleOwnerChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		const value = target.value;

		if (value === "user" && relayManager.user) {
			selectedOwner = { type: "user", user: relayManager.user };
			//} else {
			//	const org = organizations.find((o) => o.id === value);
			//	if (org) {
			//		selectedOwner = { type: "org", org };
			//	}
		}
	}

	function getSelectedValue(): string {
		if (!selectedOwner) return "";
		return selectedOwner.type === "user" ? "user" : selectedOwner.org.id;
	}

	async function fetchConfig() {
		if (!relayManager?.pb) {
			configError = "Not connected to relay service";
			return;
		}

		loadingConfig = true;
		configError = null;

		try {
			// Use customFetch directly since PocketBase's .send() tries to parse as JSON
			const fullUrl = relayManager.pb.baseUrl + "/templates/relay.toml";
			const response = await customFetch(fullUrl, {
				method: "GET",
				headers: {
					Authorization: relayManager.pb.authStore.token
						? `Bearer ${relayManager.pb.authStore.token}`
						: "",
				},
			});

			// Get the text from the response and store as template
			configTemplate = await response.text();
		} catch (err) {
			configError =
				err instanceof Error ? err.message : "Failed to fetch configuration";
		} finally {
			loadingConfig = false;
		}
	}

	// Update config whenever URL or template changes
	$: configToml = configTemplate
		? configTemplate.replace(/\{url\}/g, url || "")
		: "";

	onMount(() => {
		// Always fetch the global template
		fetchConfig();

		// Auto-select first existing host if available
		const existingHosts = relayManager.providers
			.values()
			.filter(
				(p) =>
					p.selfHosted &&
					relayManager.relays.some((relay, key) => relay.providerId === p.id),
			);
		if (existingHosts.length > 0) {
			selectedProvider.set(existingHosts[0]);
		}
	});
</script>

<div class="self-host-modal">
	<div class="setting-item-description" style="margin-bottom: 16px;">
		<p>
			Create a new self-hosted Relay Server. Select an existing host or add a
			new one.
		</p>
	</div>

	<!-- Owner Selector -->
	<SettingItem
		name="Owner"
		description="Select who will own this self-hosted relay server."
	>
		<select
			class="owner-select"
			value={getSelectedValue()}
			on:change={handleOwnerChange}
			disabled={totalOwnerOptions <= 1}
		>
			{#if relayManager.user}
				<option value="user">{relayManager.user.name} (Personal)</option>
			{/if}
			{#each organizations as org}
				<option value={org.id}>{org.name}</option>
			{/each}
		</select>
	</SettingItem>

	<!-- Error Display -->
	{#if errors.submit}
		<div class="error-message">
			{errors.submit}
		</div>
	{/if}

	<!-- Combined Host List -->
	<div class="host-list-section">
		<div class="setting-item-name">Relay Server URL</div>
		<div class="setting-item-description">
			This should be accessible to users within your private network, but not
			exposed to the public internet.
		</div>
		<div class="host-list">
			{#each $providers
				.values()
				.filter((p) => p.selfHosted && relayManager.relays.some((relay, key) => relay.providerId === p.id)) as provider (provider.id)}
				<div
					class="host-card"
					class:active={$selectedProvider?.id === provider.id}
					on:click={() => selectProvider(provider)}
					on:keydown={(e) =>
						e.key === "Enter" || e.key === " "
							? selectProvider(provider)
							: null}
					role="button"
					tabindex="0"
					title="Click to select this host"
				>
					<div class="host-info">
						<div class="host-url">{provider.url}</div>
						{#if provider.keyType === "legacy"}
							<div class="host-key-indicator">Legacy host</div>
						{/if}
					</div>
				</div>
			{/each}

			<!-- Add New Host Input (always at the end) -->
			<div class="host-card add-host-card">
				<div class="host-info">
					<input
						type="url"
						placeholder="https://relay.my-corp.ts.net"
						on:click={() => selectProvider(null)}
						bind:value={url}
						class="host-url-input"
						class:host-input-invalid={errors.url}
						title={errors.url}
					/>
				</div>
			</div>
		</div>
	</div>

	<!-- Public Key Section - only show when adding new provider -->
	{#if !$selectedProvider}
		<div class="public-key-section">
			<div class="setting-item-name">Relay Server Configuration</div>
			<div class="setting-item-description">
				Copy this configuration to your Relay Server's TOML file.
			</div>
			{#if loadingConfig}
				<div class="loading-message">Loading configuration...</div>
			{:else if configError}
				<div class="error-message">{configError}</div>
			{:else if configToml}
				<RelayConfigBlock toml={configToml} />
			{:else}
				<div class="error-message">No configuration available</div>
			{/if}
		</div>
	{/if}

	<!-- Action Button -->
	<div class="modal-button-container">
		<button
			class="mod-cta"
			on:click={handleSubmit}
			disabled={isCreating ||
				(!$selectedProvider && (!url.trim() || !!errors.url))}
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

	/* Host List Styles */
	.host-list-section {
		margin: 16px 0;
	}

	.public-key-section {
		margin: 16px 0;
	}

	.loading-message {
		background: var(--background-secondary);
		color: var(--text-muted);
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		padding: 12px;
		margin: 16px 0;
		font-size: 0.9em;
		text-align: center;
	}

	.host-list {
		display: flex;
		flex-direction: column;
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

	.error-message {
		background: var(--background-secondary);
		color: var(--text-error);
		border: 1px solid var(--text-error);
		border-radius: var(--radius-s);
		padding: 12px;
		margin: 16px 0;
		font-size: 0.9em;
	}

	.modal-button-container {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		margin-top: 24px;
		gap: 12px;
	}

	.loading-message {
		background: var(--background-secondary);
		color: var(--text-muted);
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		padding: 12px;
		margin: 16px 0;
		font-size: 0.9em;
		text-align: center;
	}

	.error-message {
		background: var(--background-secondary);
		color: var(--text-error);
		border: 1px solid var(--text-error);
		border-radius: var(--radius-s);
		padding: 12px;
		margin: 16px 0;
		font-size: 0.9em;
	}
</style>
