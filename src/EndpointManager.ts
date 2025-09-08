import { customFetch } from "./customFetch";
import { curryLog } from "./debug";
import { decodeJwt, type JWTPayload, importSPKI, jwtVerify } from "jose";
import type { NamespacedSettings } from "./SettingsStorage";

declare const API_URL: string;
declare const AUTH_URL: string;
declare const BUILD_TYPE: string;

// Hardcoded public key for endpoint validation
const ENDPOINT_VALIDATION_PUBLIC_KEY = `
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyDIav6xzBzyi6eQu8aJA
O8DufA/MyTMDsD9d6PmjhuPTSlVPharZSjxRkHi6sK50ZmRedQbyiBuNp0g6so30
+zunoqT9XUpvZD0+USlGvi0J48Cop+DQbbpTlAlsmX6BxhHJLUrmgU0AhHjvJLNL
rRuzzQxrn/Oi0byUHu/moitUypX1hSYrKH5meRy8zoyGb8b0qIOEKpcpVKGyD/ne
+u0Bhh6tI8t2vQDQK0RL87dc+EqlQXxtijXBSClqvJi7o3JYTtWtuaWcZ2pQdg5y
+gDMii2hZYLNdgDM+/NcJlp3fkPztVeVRpiV20gZDhqANSjWjx9iN1Jt9A97rCSH
XQIDAQAB
-----END PUBLIC KEY-----
`.trim();

// Validation error types
export enum ValidationErrorType {
	LICENSE_INVALID = 'LICENSE_INVALID',
	LICENSE_EXPIRED = 'LICENSE_EXPIRED',
	JWT_VERIFICATION_FAILED = 'JWT_VERIFICATION_FAILED',
	URL_INVALID = 'URL_INVALID',
	NETWORK_ERROR = 'NETWORK_ERROR',
	LICENSE_NOT_FOUND = 'LICENSE_NOT_FOUND'
}

export class ValidationError extends Error {
	constructor(
		message: string,
		public readonly type: ValidationErrorType,
		public readonly details?: unknown
	) {
		super(message);
		this.name = 'ValidationError';
	}
}

export interface TenantConfig {
	id: string;  // Unique identifier for this tenant
	name: string;  // Display name (from license customer field or derived from URL)
	tenantUrl: string;  // Auth URL for this tenant
	apiUrl?: string;  // Cached from last successful validation
	authUrl?: string;  // Cached from last successful validation
	customer?: string;  // Customer name from license
	logo?: string;  // Logo URL from license
	isValidated: boolean;  // Whether this tenant has been successfully validated
	lastValidated?: number;  // Timestamp of last successful validation
	environment?: string;  // production, staging, etc.
}

export interface EndpointSettings {
	tenants?: TenantConfig[];  // List of configured tenants
	activeTenantId?: string;  // ID of currently active tenant
	_lastValidationError?: string;
	_lastValidationAttempt?: number;
}

export interface License {
	license: string;
	id?: string;
	url?: string;
}

export interface LicenseMetadata {
	[key: string]: unknown;
}

export interface LicenseInfo {
	issuer: string;
	subject: string;
	validFrom: string;
	validTo: string;
	isValid: boolean;
}

interface EndpointJWTPayload extends JWTPayload {
	apiUrl?: string;
	authUrl?: string;
	customer?: string;
	logo?: string;
}

// Type guards
function isLicense(obj: unknown): obj is License {
	return typeof obj === 'object' && 
		obj !== null && 
		'license' in obj && 
		typeof (obj as any).license === 'string';
}

function isLicenseArray(data: unknown): data is License[] {
	return Array.isArray(data) && data.every(isLicense);
}

export class EndpointManager {
	private log = curryLog("[EndpointManager]");
	private _validatedApiUrl?: string;
	private _validatedAuthUrl?: string;
	private _publicKeyCache?: CryptoKey;

	constructor(private settings: NamespacedSettings<EndpointSettings>) {}

	/**
	 * Check if we're running in a development/staging environment
	 * Uses the BUILD_TYPE constant set during compilation
	 */
	public isStaging(): boolean {
		return BUILD_TYPE === "debug";
	}

	/**
	 * Sanitize URL for logging (remove sensitive query params)
	 */
	private sanitizeUrlForLog(url: string): string {
		try {
			const parsedUrl = new URL(url);
			// Remove query parameters that might contain sensitive data
			parsedUrl.search = '';
			return parsedUrl.toString();
		} catch {
			// If URL parsing fails, just return the original URL
			return url;
		}
	}

	/**
	 * Validate URL format and security constraints
	 */
	private validateUrl(url: string): void {
		if (!url || typeof url !== 'string') {
			throw new ValidationError('URL must be a non-empty string', ValidationErrorType.URL_INVALID);
		}

		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			throw new ValidationError('Invalid URL format', ValidationErrorType.URL_INVALID);
		}

		// Protocol validation - allow HTTP in development builds, HTTPS only in production
		const isDevelopment = this.isStaging();
		if (isDevelopment) {
			if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
				throw new ValidationError('Only HTTP and HTTPS URLs are allowed in development', ValidationErrorType.URL_INVALID);
			}
		} else {
			if (parsedUrl.protocol !== 'https:') {
				throw new ValidationError('Only HTTPS URLs are allowed in production', ValidationErrorType.URL_INVALID);
			}
		}

		// Warn about localhost usage
		const hostname = parsedUrl.hostname.toLowerCase();
		if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
			this.log(`Warning: Using localhost endpoint (development build: ${isDevelopment})`);
		}

		// Basic hostname validation
		if (!hostname || hostname.length < 3) {
			throw new ValidationError('Invalid hostname', ValidationErrorType.URL_INVALID);
		}
	}

	/**
	 * Get or create the public key for JWT verification
	 */
	private async getPublicKey(): Promise<CryptoKey> {
		if (this._publicKeyCache) {
			return this._publicKeyCache;
		}

		try {
			this._publicKeyCache = await importSPKI(ENDPOINT_VALIDATION_PUBLIC_KEY, 'RS256');
			return this._publicKeyCache;
		} catch (error) {
			throw new ValidationError(
				'Failed to import public key',
				ValidationErrorType.JWT_VERIFICATION_FAILED,
				error
			);
		}
	}

	/**
	 * Get the current API URL - either validated custom URL or default
	 */
	getApiUrl(): string {
		return this._validatedApiUrl || API_URL;
	}

	/**
	 * Get the current AUTH URL - either validated custom URL or default
	 */
	getAuthUrl(): string {
		return this._validatedAuthUrl || AUTH_URL;
	}

	/**
	 * Get the default API and AUTH URLs (for displaying in UI)
	 */
	getDefaultUrls(): { apiUrl: string; authUrl: string; environment: string } {
		return {
			apiUrl: API_URL,
			authUrl: AUTH_URL,
			environment: BUILD_TYPE === 'debug' ? 'staging' : 'production'
		};
	}

	/**
	 * Validate enterprise tenant by checking the license and updating internal state
	 */
	async validateAndSetEndpoints(timeoutMs: number = 10000): Promise<{
		success: boolean;
		error?: string;
		licenseInfo?: LicenseInfo;
	}> {
		const endpointSettings = this.settings.get();
		
		// If no active tenant is set, use defaults
		const activeTenant = this.getActiveTenant(endpointSettings);
		if (!activeTenant) {
			this.log("No active enterprise tenant configured, using defaults");
			this._validatedApiUrl = undefined;
			this._validatedAuthUrl = undefined;
			return { success: true };
		}

		try {
			// Wrap validation in a timeout promise
			const validationPromise = this.performTenantValidation(activeTenant.tenantUrl);
			const timeoutPromise = new Promise<never>((_, reject) => 
				setTimeout(() => reject(new Error(`Validation timed out after ${timeoutMs}ms`)), timeoutMs)
			);

			const result = await Promise.race([validationPromise, timeoutPromise]);
			return result;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			this.log("Failed to validate tenant:", errorMessage);
			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Perform tenant validation by fetching and verifying the license
	 */
	private async performTenantValidation(tenantUrl: string): Promise<{
		success: boolean;
		error?: string;
		licenseInfo?: LicenseInfo;
	}> {
		try {
			// Validate tenant URL first
			this.validateUrl(tenantUrl);

			// Fetch license from the tenant URL (which is the auth URL)
			const licenseResult = await this.fetchTenantLicense(tenantUrl);
			if (!licenseResult.success) {
				return {
					success: false,
					error: `Failed to fetch tenant license: ${licenseResult.error}`
				};
			}

			// Validate the license
			const validation = await this.validateTenantLicense(licenseResult.license!, tenantUrl);
			if (!validation.success) {
				return {
					success: false,
					error: `Tenant license validation failed: ${validation.error}`
				};
			}

			// Extract apiUrl and authUrl from the validated license
			const payload = await this.verifyJWT(licenseResult.license!);
			
			if (!payload.apiUrl || !payload.authUrl) {
				return {
					success: false,
					error: 'License missing required apiUrl or authUrl'
				};
			}

			// Verify tenant URL matches authUrl in license
			if (payload.authUrl !== tenantUrl) {
				return {
					success: false,
					error: `Tenant URL mismatch: expected ${tenantUrl}, license has ${payload.authUrl}`
				};
			}

			// Update internal state with validated endpoints
			this._validatedApiUrl = payload.apiUrl;
			this._validatedAuthUrl = payload.authUrl;

			this.log("Successfully validated enterprise tenant", {
				tenant: tenantUrl,
				apiUrl: this._validatedApiUrl,
				authUrl: this._validatedAuthUrl,
				customer: payload.customer
			});

			return {
				success: true,
				licenseInfo: validation.licenseInfo
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			return {
				success: false,
				error: errorMessage
			};
		}
	}


	/**
	 * Fetch tenant license from the tenant URL
	 */
	private async fetchTenantLicense(tenantUrl: string): Promise<{
		success: boolean;
		license?: string;
		error?: string;
	}> {
		try {
			const url = new URL(tenantUrl);
			const certUrl = `${url.protocol}//${url.host}/.well-known/relay.md/license`;

			this.log(`Fetching tenant license from:`, certUrl);
			
			const response = await customFetch(certUrl, {
				method: "GET",
				headers: {
					"Content-Type": "application/json"
				}
			});

			if (!response.ok) {
				throw new Error(`License fetch failed: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			
			// Parse licenses using type guards
			let licenses: License[] = [];
			
			if (isLicenseArray(data)) {
				licenses = data;
			} else if (data && typeof data === 'object' && 'licenses' in data && isLicenseArray(data.licenses)) {
				licenses = data.licenses;
			} else if (isLicense(data)) {
				licenses = [data];
			} else {
				throw new ValidationError(
					"No valid licenses found in response",
					ValidationErrorType.LICENSE_NOT_FOUND
				);
			}

			if (licenses.length === 0) {
				throw new Error("Empty license list");
			}

			// For tenant validation, we expect a single license or take the first one
			const license = licenses[0];
			
			return {
				success: true,
				license: license.license
			};

		} catch (error) {
			let errorMessage = error instanceof Error ? error.message : "Unknown error";
			
			// Make connection errors more user-friendly
			if (errorMessage.includes('Failed to fetch') || 
				errorMessage.includes('NetworkError') ||
				errorMessage.includes('ERR_') ||
				errorMessage.includes('ECONNREFUSED')) {
				errorMessage = `Unable to connect to ${tenantUrl}. Please check the URL and ensure the server is running.`;
			} else if (errorMessage.includes('404')) {
				errorMessage = `No tenant license found at ${tenantUrl}. This may not be a valid Enterprise Relay tenant.`;
			} else if (errorMessage.includes('License fetch failed')) {
				// Keep the existing error message as it's already user-friendly
			}
			
			this.log("Tenant license fetch error:", errorMessage);
			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Find a license that matches the requested endpoint
	 */
	private findMatchingEndpointLicense(
		licenses: License[], 
		endpointUrl: string, 
		endpointType: 'api' | 'auth'
	): License | null {
		this.log(`Searching for ${endpointType} license for ${this.sanitizeUrlForLog(endpointUrl)}`);

		for (const lic of licenses) {
			try {
				// Decode the JWT to check if it matches our endpoint
				const payload = decodeJwt(lic.license) as EndpointJWTPayload;

				// Check if this license is for the right endpoint type and URL
				if (payload.endpointType === endpointType && payload.url === endpointUrl) {
					this.log(`Found matching license for ${endpointType}: ${this.sanitizeUrlForLog(endpointUrl)}`);
					return lic;
				}
			} catch (error) {
				// Skip invalid tokens
				continue;
			}
		}

		return null;
	}

	/**
	 * Validate tenant license JWT and extract license info
	 */
	private async validateTenantLicense(
		license: string, 
		tenantUrl: string
	): Promise<{
		success: boolean;
		licenseInfo?: LicenseInfo;
		error?: string;
	}> {
		this.log(`Tenant license validation starting: ${this.sanitizeUrlForLog(tenantUrl)}`);
		
		try {
			// JWT verification with jose library
			const payload = await this.verifyJWT(license);
			
			// Validate license claims for tenant
			if (payload.iss !== AUTH_URL) {
				throw new ValidationError(
					`Invalid token issuer: expected ${AUTH_URL}, got ${payload.iss}`,
					ValidationErrorType.LICENSE_INVALID
				);
			}

			if (payload.sub !== "endpoint-certificate") {
				throw new ValidationError(
					`Invalid token subject: expected "endpoint-certificate", got ${payload.sub}`,
					ValidationErrorType.LICENSE_INVALID
				);
			}

			// Extract license info
			const licenseInfo: LicenseInfo = {
				issuer: payload.iss || "Unknown",
				subject: payload.sub || "Unknown", 
				validFrom: payload.iat ? new Date(payload.iat * 1000).toISOString() : "Unknown",
				validTo: payload.exp ? new Date(payload.exp * 1000).toISOString() : "Unknown",
				isValid: true
			};

			this.log(`Tenant license validation successful: ${this.sanitizeUrlForLog(tenantUrl)}`);

			return {
				success: true,
				licenseInfo
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			this.log(`Tenant license validation failed: ${this.sanitizeUrlForLog(tenantUrl)} - ${errorMessage}`);
			
			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Validate license claims against expected values
	 */
	private validateLicenseClaims(
		payload: EndpointJWTPayload,
		endpointType: 'api' | 'auth',
		endpointUrl: string
	): void {
		// Check issuer
		if (payload.iss !== AUTH_URL) {
			throw new ValidationError(
				`Invalid token issuer: expected ${AUTH_URL}, got ${payload.iss}`,
				ValidationErrorType.LICENSE_INVALID
			);
		}

		// Check subject
		if (payload.sub !== "endpoint-certificate") {
			throw new ValidationError(
				`Invalid token subject: expected "endpoint-certificate", got ${payload.sub}`,
				ValidationErrorType.LICENSE_INVALID
			);
		}

		// Check endpoint type
		if (payload.endpointType !== endpointType) {
			throw new ValidationError(
				`License endpoint type mismatch: expected ${endpointType}, got ${payload.endpointType}`,
				ValidationErrorType.LICENSE_INVALID
			);
		}

		// Check endpoint URL
		if (payload.url !== endpointUrl) {
			throw new ValidationError(
				`License URL mismatch: expected ${endpointUrl}, got ${payload.url}`,
				ValidationErrorType.LICENSE_INVALID
			);
		}
	}

	/**
	 * Verify JWT using jose library with proper algorithm validation
	 */
	private async verifyJWT(token: string): Promise<EndpointJWTPayload> {
		try {
			const publicKey = await this.getPublicKey();
			const { payload } = await jwtVerify(token, publicKey, {
				algorithms: ['RS256'], // Explicitly only allow RS256
			});
			
			return payload as EndpointJWTPayload;
		} catch (error) {
			this.log("JWT verification failed:", error);
			throw new ValidationError(
				`JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
				ValidationErrorType.JWT_VERIFICATION_FAILED,
				error
			);
		}
	}

	/**
	 * Clear validated endpoints and revert to defaults
	 */
	clearValidatedEndpoints(): void {
		this._validatedApiUrl = undefined;
		this._validatedAuthUrl = undefined;
		this.log("Cleared validated endpoints, reverted to defaults");
	}

	/**
	 * Check if custom endpoints are currently validated and active
	 */
	hasValidatedEndpoints(): boolean {
		return !!(this._validatedApiUrl && this._validatedAuthUrl);
	}

	/**
	 * Get the active tenant configuration
	 */
	private getActiveTenant(settings: EndpointSettings): TenantConfig | undefined {
		if (!settings.activeTenantId || !settings.tenants) {
			return undefined;
		}
		return settings.tenants.find(t => t.id === settings.activeTenantId);
	}

	/**
	 * Generate a unique tenant ID from URL
	 */
	private generateTenantId(tenantUrl: string): string {
		try {
			const url = new URL(tenantUrl);
			return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
		} catch {
			return tenantUrl.replace(/[^a-zA-Z0-9]/g, '_');
		}
	}

	/**
	 * Add a new tenant to the list and optionally validate it
	 */
	async addTenant(tenantUrl: string, validate: boolean = true): Promise<{
		success: boolean;
		error?: string;
		tenantId?: string;
		licenseInfo?: LicenseInfo;
	}> {
		try {
			// Validate URL format first
			this.validateUrl(tenantUrl);

			const tenantId = this.generateTenantId(tenantUrl);
			const settings = this.settings.get();

			// Check if tenant already exists
			if (settings.tenants?.some(t => t.id === tenantId)) {
				return {
					success: false,
					error: "This tenant is already configured"
				};
			}

			let tenantConfig: TenantConfig = {
				id: tenantId,
				name: tenantUrl, // Will be updated with customer name if validation succeeds
				tenantUrl: tenantUrl,
				isValidated: false
			};

			let validationResult: {
				success: boolean;
				licenseInfo?: LicenseInfo;
				error?: string;
			} | undefined;

			if (validate) {
				// Validate the tenant license
				const licenseResult = await this.fetchTenantLicense(tenantUrl);
				if (!licenseResult.success) {
					return {
						success: false,
						error: licenseResult.error || "Failed to fetch tenant license"
					};
				}

				const validation = await this.validateTenantLicense(licenseResult.license!, tenantUrl);
				if (!validation.success) {
					return {
						success: false,
						error: validation.error || "Tenant license validation failed"
					};
				}

				validationResult = validation;

				// Extract tenant information from license
				const payload = await this.verifyJWT(licenseResult.license!);
				
				tenantConfig = {
					...tenantConfig,
					name: payload.customer || tenantUrl,
					apiUrl: payload.apiUrl,
					authUrl: payload.authUrl,
					customer: payload.customer,
					logo: payload.logo,
					environment: payload.environment as string,
					isValidated: true,
					lastValidated: Date.now()
				};
			}

			// Add tenant to settings
			await this.settings.update((current) => ({
				...current,
				tenants: [...(current.tenants || []), tenantConfig]
			}));

			return {
				success: true,
				tenantId: tenantId,
				licenseInfo: validationResult?.licenseInfo
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Remove a tenant from the list
	 */
	async removeTenant(tenantId: string): Promise<boolean> {
		const settings = this.settings.get();
		const tenants = settings.tenants || [];
		
		if (!tenants.some(t => t.id === tenantId)) {
			return false;
		}

		// If removing the active tenant, clear it
		const updates: Partial<EndpointSettings> = {
			tenants: tenants.filter(t => t.id !== tenantId)
		};

		if (settings.activeTenantId === tenantId) {
			updates.activeTenantId = undefined;
			// Clear validated endpoints
			this._validatedApiUrl = undefined;
			this._validatedAuthUrl = undefined;
		}

		await this.settings.update((current) => ({
			...current,
			...updates
		}));

		return true;
	}

	/**
	 * Switch to a different tenant
	 */
	async switchToTenant(tenantId: string): Promise<{
		success: boolean;
		error?: string;
	}> {
		const settings = this.settings.get();
		const tenant = settings.tenants?.find(t => t.id === tenantId);
		
		if (!tenant) {
			return {
				success: false,
				error: "Tenant not found"
			};
		}

		await this.settings.update((current) => ({
			...current,
			activeTenantId: tenantId
		}));

		// Apply the tenant's endpoints if validated
		if (tenant.isValidated && tenant.apiUrl && tenant.authUrl) {
			this._validatedApiUrl = tenant.apiUrl;
			this._validatedAuthUrl = tenant.authUrl;
		} else {
			this._validatedApiUrl = undefined;
			this._validatedAuthUrl = undefined;
		}

		return { success: true };
	}

	/**
	 * Get customer branding information from validated tenant
	 */
	async getCustomerInfo(): Promise<{ customer?: string; logo?: string } | null> {
		if (!this.hasValidatedEndpoints()) {
			return null;
		}

		const endpointSettings = this.settings.get();
		const activeTenant = this.getActiveTenant(endpointSettings);
		if (!activeTenant) {
			return null;
		}

		try {
			// Use cached customer info if available and tenant is validated
			if (activeTenant.isValidated && activeTenant.customer) {
				return {
					customer: activeTenant.customer,
					logo: activeTenant.logo
				};
			}

			// Fetch and decode the tenant license to get customer info
			const licenseResult = await this.fetchTenantLicense(activeTenant.tenantUrl);
			
			if (licenseResult.success && licenseResult.license) {
				const payload = await this.verifyJWT(licenseResult.license);
				return {
					customer: payload.customer,
					logo: payload.logo
				};
			}
		} catch (error) {
			this.log("Failed to get customer info:", error);
		}

		return null;
	}

	/**
	 * Get default tenant branding information from license endpoint
	 */
	async getDefaultTenantInfo(): Promise<{ customer?: string; logo?: string; environment?: string } | null> {
		try {
			// Fetch license from the default auth URL
			const licenseResult = await this.fetchTenantLicense(AUTH_URL);
			
			if (licenseResult.success && licenseResult.license) {
				const payload = await this.verifyJWT(licenseResult.license);
				return {
					customer: payload.customer,
					logo: payload.logo,
					environment: BUILD_TYPE === 'debug' ? 'staging' : 'production'
				};
			}
		} catch (error) {
			this.log("Failed to get default tenant info:", error);
		}

		return null;
	}

	/**
	 * Test validate tenant without modifying internal state
	 */
	async testValidateTenant(tenantUrl: string, timeoutMs: number = 10000): Promise<{
		success: boolean;
		error?: string;
		licenseInfo?: LicenseInfo;
	}> {
		try {
			// Wrap validation in a timeout promise
			const validationPromise = this.performTestValidation(tenantUrl);
			const timeoutPromise = new Promise<never>((_, reject) => 
				setTimeout(() => reject(new Error(`Validation timed out after ${timeoutMs}ms`)), timeoutMs)
			);

			const result = await Promise.race([validationPromise, timeoutPromise]);
			return result;

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			this.log("Failed to test validate endpoints:", errorMessage);
			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Perform test validation without modifying internal state
	 */
	private async performTestValidation(tenantUrl: string): Promise<{
		success: boolean;
		error?: string;
		licenseInfo?: LicenseInfo;
	}> {
		try {
			// Validate tenant URL format first
			this.validateUrl(tenantUrl);

			// Fetch tenant license
			const licenseResult = await this.fetchTenantLicense(tenantUrl);
			if (!licenseResult.success) {
				return {
					success: false,
					error: `Failed to fetch tenant license: ${licenseResult.error}`
				};
			}

			// Validate the tenant license
			const validation = await this.validateTenantLicense(licenseResult.license!, tenantUrl);
			if (!validation.success) {
				return {
					success: false,
					error: `Tenant license validation failed: ${validation.error}`
				};
			}

			// Extract apiUrl and authUrl from the validated license (for logging)
			const payload = await this.verifyJWT(licenseResult.license!);
			
			this.log("Test validation successful for tenant", { 
				tenantUrl, 
				apiUrl: payload.apiUrl, 
				authUrl: payload.authUrl 
			});

			return {
				success: true,
				licenseInfo: validation.licenseInfo
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Fetch license for test validation (doesn't use internal state)
	 */
	private async fetchEndpointLicenseForUrl(
		authUrl: string,
		endpointType: 'api' | 'auth',
		targetUrl: string
	): Promise<{
		success: boolean;
		license?: string;
		error?: string;
	}> {
		try {
			const url = new URL(authUrl);
			const certUrl = `${url.protocol}//${url.host}/.well-known/relay.md/license`;

			this.log(`Fetching ${endpointType.toUpperCase()} licenses for test validation from:`, certUrl);
			
			const response = await customFetch(certUrl, {
				method: "GET",
				headers: {
					"Content-Type": "application/json"
				}
			});

			if (!response.ok) {
				throw new Error(`License fetch failed: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			
			this.log("License response received from:", certUrl);
			
			// Parse licenses using type guards
			let licenses: License[] = [];
			
			if (isLicenseArray(data)) {
				licenses = data;
			} else if (data && typeof data === 'object' && 'licenses' in data && isLicenseArray(data.licenses)) {
				licenses = data.licenses;
			} else if (isLicense(data)) {
				licenses = [data];
			} else {
				throw new ValidationError(
					"No valid licenses found in response",
					ValidationErrorType.LICENSE_NOT_FOUND
				);
			}
			
			this.log(`Parsed ${licenses.length} licenses`);

			if (licenses.length === 0) {
				throw new Error("Empty license list");
			}

			// Find a valid license for this specific endpoint
			const matchingLicense = this.findMatchingEndpointLicense(licenses, targetUrl, endpointType);
			
			if (!matchingLicense) {
				throw new ValidationError(
					`No valid ${endpointType.toUpperCase()} license found for: ${targetUrl}`,
					ValidationErrorType.LICENSE_NOT_FOUND
				);
			}

			return {
				success: true,
				license: matchingLicense.license
			};

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			this.log("License fetch error:", errorMessage);
			return {
				success: false,
				error: `License fetch failed: ${errorMessage}`
			};
		}
	}


}
