<script lang="ts">
	import { createEventDispatcher, onMount } from "svelte";
	import SettingItem from "./SettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import type Live from "../main";
	import type { TenantConfig } from "../EndpointManager";

	export let plugin: Live;

	const dispatch = createEventDispatcher();

	let newTenantUrl = "";
	let isValidating = false;
	let validationState = { isValid: true, error: "" };
	let errorMessage = "";
	let showInputError = false;
	let previousTenantUrl = ""; // Track previous value to detect actual typing
	let hasChanges = false; // Track if any changes were made

	// Reactive settings - force updates by creating a refresh trigger
	let refreshTrigger = 0;
	
	// Get current settings and tenant list
	$: currentSettings = (refreshTrigger, plugin.endpointSettings.get());
	$: tenants = currentSettings.tenants || [];
	$: activeTenantId = currentSettings.activeTenantId;
	$: activeTenant = tenants.find(t => t.id === activeTenantId);
	$: hasValidatedEndpoints = plugin.loginManager.getEndpointManager().hasValidatedEndpoints();
	
	// Get default URLs from the build configuration
	const defaultUrls = plugin.loginManager.getEndpointManager().getDefaultUrls();
	
	// Default tenant info (logo, customer name)
	let defaultTenantInfo: { customer?: string; logo?: string; environment?: string } | null = null;

	function forceUpdate() {
		refreshTrigger++;
	}

	function dismissError() {
		errorMessage = "";
		showInputError = false;
	}

	// Validate URL format without network calls
	function validateUrlFormat(url: string): { isValid: boolean; error: string } {
		if (!url.trim()) {
			return { isValid: true, error: "" }; // Empty is valid (uses default)
		}

		try {
			const parsed = new URL(url);
			const isDevelopment = plugin.loginManager.getEndpointManager().isStaging();
			
			// Protocol validation - allow HTTP in development builds, HTTPS only in production
			if (isDevelopment) {
				if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
					return { isValid: false, error: 'Only HTTP and HTTPS URLs are allowed in development' };
				}
			} else {
				if (parsed.protocol !== 'https:') {
					return { isValid: false, error: 'Only HTTPS URLs are allowed in production' };
				}
			}
			
			if (parsed.hostname.length < 3) {
				return { isValid: false, error: 'Invalid hostname' };
			}
			return { isValid: true, error: '' };
		} catch {
			return { isValid: false, error: 'Invalid URL format' };
		}
	}

	// Update validation state when URL changes
	$: {
		validationState = validateUrlFormat(newTenantUrl);
		// Only clear errors if the user actually typed something new (not on initial error setting)
		if (newTenantUrl !== previousTenantUrl && previousTenantUrl !== "") {
			// Clear input error when user starts typing
			if (showInputError) {
				showInputError = false;
			}
			// Clear general error message when user starts typing
			if (errorMessage) {
				errorMessage = "";
			}
		}
		previousTenantUrl = newTenantUrl;
	}

	// Add new tenant
	async function addTenant() {
		if (!newTenantUrl.trim()) {
			return;
		}

		if (!validationState.isValid) {
			return;
		}

		isValidating = true;

		try {
			const result = await plugin.loginManager.getEndpointManager().addTenant(newTenantUrl);
			
			if (result.success) {
				newTenantUrl = "";
				errorMessage = "";
				showInputError = false;
				forceUpdate(); // Trigger UI refresh
				hasChanges = true;
				// Automatically switch to the new tenant
				if (result.tenantId) {
					await switchToTenant(result.tenantId);
				}
			} else {
				console.log("Add tenant failed with error:", result.error);
				errorMessage = result.error || "Failed to add tenant";
				showInputError = true;
				forceUpdate(); // Force UI refresh to show error
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
			errorMessage = `Error adding tenant: ${errorMsg}`;
			showInputError = true;
		} finally {
			isValidating = false;
		}
	}

	// Switch to a different tenant
	async function switchToTenant(tenantId: string) {
		try {
			const result = await plugin.loginManager.getEndpointManager().switchToTenant(tenantId);
			if (result.success) {
				hasChanges = true;
				forceUpdate(); // Trigger UI refresh
			} else {
				errorMessage = result.error || "Failed to switch tenant";
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
			errorMessage = `Error switching tenant: ${errorMsg}`;
		}
	}

	// Remove a tenant
	async function removeTenant(tenantId: string) {
		try {
			const success = await plugin.loginManager.getEndpointManager().removeTenant(tenantId);
			if (success) {
				hasChanges = true;
				forceUpdate(); // Trigger UI refresh
			} else {
				errorMessage = "Failed to remove tenant";
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error occurred";
			errorMessage = `Error removing tenant: ${errorMsg}`;
		}
	}

	// Use default tenant (clear active tenant)
	async function useDefaultTenant() {
		await plugin.endpointSettings.update((current) => ({
			...current,
			activeTenantId: undefined
		}));
		plugin.loginManager.getEndpointManager().clearValidatedEndpoints();
		hasChanges = true;
		forceUpdate(); // Trigger UI refresh
	}

	// Get customer info for branding
	async function getCustomerInfo() {
		try {
			const endpointManager = plugin.loginManager.getEndpointManager();
			return await endpointManager.getCustomerInfo();
		} catch {
			return null;
		}
	}

	// Load default tenant info from license endpoint
	async function loadDefaultTenantInfo() {
		try {
			const endpointManager = plugin.loginManager.getEndpointManager();
			defaultTenantInfo = await endpointManager.getDefaultTenantInfo();
		} catch (error) {
			console.log("Failed to load default tenant info:", error);
			defaultTenantInfo = null;
		}
	}

	// Load default tenant info when component mounts
	onMount(() => {
		loadDefaultTenantInfo();
	});
</script>

<div class="endpoint-config-modal">
	<div class="setting-item-description" style="margin-bottom: 16px;">
		<p>Manage your organization's enterprise Relay tenants. Add tenants to switch between different enterprise deployments.</p>
	</div>


	<!-- Add New Tenant -->
	<SettingItem 
		name="Add Enterprise Tenant"
		description="Enter your organization's tenant URL"
	>
		<div class="add-tenant-container">
			<input 
				type="text" 
				placeholder="https://auth.example.com"
				bind:value={newTenantUrl}
				class="endpoint-url-input"
				class:endpoint-input-invalid={!validationState.isValid || showInputError}
					title={validationState.error}
			/>
			<button 
				class="mod-cta"
				on:click={addTenant}
				disabled={isValidating || !newTenantUrl.trim() || !validationState.isValid}
			>
				{isValidating ? "Adding..." : "Add Tenant"}
			</button>
		</div>
	</SettingItem>

	<!-- Error Message Display -->
	{#if errorMessage && errorMessage.trim()}
		<div class="error-banner">
			<div class="error-content">
				<span class="error-icon">⚠️</span>
				<span class="error-text">{errorMessage}</span>
			</div>
			<button class="error-dismiss" on:click={dismissError} title="Dismiss error">
				×
			</button>
		</div>
	{/if}

	<!-- Tenant List -->
	<div class="tenant-list-section">
		<div class="setting-item-name">Available Tenants</div>
		<div class="tenant-list">
			<!-- Default Tenant (always first) -->
			<div 
				class="tenant-card" 
				class:active={!activeTenantId}
				on:click={useDefaultTenant}
				on:keydown={(e) => e.key === 'Enter' || e.key === ' ' ? useDefaultTenant() : null}
				role="button"
				tabindex="0"
				title="Click to use default tenant"
			>
				<div class="tenant-info">
					{#if defaultTenantInfo?.logo}
						<img src={defaultTenantInfo.logo} alt={defaultTenantInfo.customer || "Default Tenant"} class="tenant-logo" />
					{/if}
					<div class="tenant-details">
						<div class="tenant-name">{defaultTenantInfo?.customer || "Default Tenant"}</div>
						<div class="tenant-url">{defaultUrls.authUrl}</div>
						<div class="tenant-env">{defaultTenantInfo?.environment || defaultUrls.environment}</div>
					</div>
				</div>
				<div class="tenant-actions">
				</div>
			</div>

			<!-- Enterprise Tenants -->
			{#each tenants as tenant (tenant.id)}
				<div 
					class="tenant-card" 
					class:active={tenant.id === activeTenantId}
					on:click={() => switchToTenant(tenant.id)}
					on:keydown={(e) => e.key === 'Enter' || e.key === ' ' ? switchToTenant(tenant.id) : null}
					role="button"
					tabindex="0"
					title="Click to switch to this tenant"
				>
					<div class="tenant-info">
						{#if tenant.logo}
							<img src={tenant.logo} alt={tenant.name} class="tenant-logo" />
						{/if}
						<div class="tenant-details">
							<div class="tenant-name">{tenant.name}</div>
							<div class="tenant-url">{tenant.tenantUrl}</div>
							{#if tenant.environment}
								<div class="tenant-env">{tenant.environment}</div>
							{/if}
						</div>
					</div>
					<div class="tenant-actions">
						<button 
							class="mod-destructive"
							on:click|stopPropagation={() => removeTenant(tenant.id)}
							title="Remove this tenant"
						>
							Remove
						</button>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- Apply Button -->
	<div class="apply-section">
		<button class="mod-cta apply-btn" on:click={() => { if (hasChanges) dispatch('apply'); else dispatch('close'); }}>Apply</button>
	</div>
</div>

<style>
	.endpoint-config-modal {
		padding: 0;
	}

	.tenant-list-section {
		margin: 16px 0;
	}

	.tenant-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px;
		margin: 8px 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		background: var(--background-primary);
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.tenant-card:hover {
		background: var(--background-modifier-hover);
	}

	.tenant-card.active {
		border-color: var(--interactive-accent);
		background: var(--background-modifier-hover);
	}



	.tenant-info {
		display: flex;
		align-items: center;
		gap: 12px;
		flex: 1;
	}

	.tenant-logo {
		width: 4em;
		height: 4em;
		object-fit: contain;
		border-radius: 4px;
		background: var(--background-secondary);
		padding: 4px;
	}

	.tenant-details {
		flex: 1;
	}

	.tenant-name {
		font-weight: 500;
		color: var(--text-normal);
		margin-bottom: 2px;
	}

	.tenant-url {
		font-size: 0.85em;
		color: var(--text-muted);
		font-family: var(--font-monospace);
	}

	.tenant-env {
		font-size: 0.8em;
		color: var(--text-faint);
		text-transform: capitalize;
	}

	.tenant-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}



	.add-tenant-container {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.endpoint-url-input {
		flex: 1;
		padding: 6px 12px;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s);
		background: var(--background-primary);
		color: var(--text-normal);
	}

	.endpoint-input-invalid {
		border-color: var(--text-error) !important;
		box-shadow: 0 0 0 1px var(--text-error) !important;
		transition: border-color 0.3s ease, box-shadow 0.3s ease;
	}

	.endpoint-input-invalid:focus {
		border-color: var(--text-error) !important;
		box-shadow: 0 0 0 2px var(--text-error) !important;
	}



	.add-tenant-container button.mod-cta {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		padding: 6px 12px;
		white-space: nowrap;
	}

	.error-banner {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin: 12px 0;
		padding: 10px 12px;
		background-color: rgba(255, 0, 0, 0.1);
		color: var(--text-normal);
		border: 1px solid rgba(255, 0, 0, 0.3);
		border-radius: var(--radius-s);
		animation: error-slide-in 0.3s ease-out;
	}

	.error-content {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		flex: 1;
	}

	.error-icon {
		font-size: 1em;
		line-height: 1.2;
		margin-top: 2px;
	}

	.error-text {
		font-size: 0.85em;
		line-height: 1.4;
		color: var(--text-normal);
	}

	.error-dismiss {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 1.2em;
		font-weight: normal;
		cursor: pointer;
		padding: 0;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: opacity 0.2s ease;
		opacity: 0.6;
	}

	.error-dismiss:hover {
		opacity: 1;
	}

	@keyframes error-slide-in {
		0% {
			opacity: 0;
			transform: translateY(-10px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.apply-section {
		display: flex;
		justify-content: flex-end;
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.apply-btn {
		padding: 8px 20px;
		font-size: 0.9em;
	}
</style>