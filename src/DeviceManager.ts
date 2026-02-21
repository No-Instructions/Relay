"use strict";

import { Platform } from "obsidian";
import type { LoginManager } from "./LoginManager";
import { Observable } from "./observable/Observable";

const DEVICE_ID_KEY = "relay-device-id";

/**
 * Generate a PocketBase-compatible ID.
 * Format: 15 characters, lowercase alphanumeric only.
 */
function generatePocketBaseId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const array = new Uint8Array(15);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => chars[byte % chars.length]).join("");
}

/**
 * Get platform string for device registration.
 */
function getPlatform(): string {
	if (Platform.isIosApp) return "Phone (iOS)";
	if (Platform.isAndroidApp) return "Phone (Android)";
	if (Platform.isMacOS) return "Desktop (macOS)";
	if (Platform.isWin) return "Desktop (Windows)";
	if (Platform.isLinux) return "Desktop (Linux)";
	if (Platform.isMobile) return "Mobile";
	return "Desktop";
}

export class DeviceManager extends Observable<DeviceManager> {
	private deviceId: string | null = null;
	private registered = false;

	constructor(
		private appId: string,
		private vaultName: string,
		private loginManager: LoginManager,
	) {
		super("DeviceManager");
	}

	/**
	 * Get or create the device ID from localStorage.
	 */
	getDeviceId(): string {
		if (this.deviceId) return this.deviceId;

		let id = localStorage.getItem(DEVICE_ID_KEY);
		if (!id) {
			id = generatePocketBaseId();
			localStorage.setItem(DEVICE_ID_KEY, id);
			this.log("Generated new device ID:", id);
		}
		this.deviceId = id;
		return id;
	}

	/**
	 * Get platform string.
	 */
	getPlatform(): string {
		return getPlatform();
	}

	/**
	 * Register device and vault with PocketBase.
	 * Creates records if they don't exist, updates if they do.
	 */
	async register(): Promise<void> {
		if (this.registered) {
			this.debug("Already registered this session");
			return;
		}

		if (!this.loginManager.loggedIn) {
			this.debug("Not logged in, skipping registration");
			return;
		}

		const deviceId = this.getDeviceId();
		const platform = this.getPlatform();
		const userId = this.loginManager.user?.id;

		if (!userId) {
			this.warn("No user ID available");
			return;
		}

		try {
			// Register device
			await this.registerDevice(deviceId, platform, userId);

			// Register vault
			await this.registerVault(this.appId, this.vaultName, deviceId, userId);

			this.registered = true;
			this.log("Device and vault registered successfully");
		} catch (error) {
			this.error("Failed to register device/vault:", error);
		}
	}

	private async registerDevice(
		deviceId: string,
		platform: string,
		userId: string,
	): Promise<void> {
		const pb = this.loginManager.pb;

		try {
			// Try to create new device record
			await pb.collection("devices").create({
				id: deviceId,
				name: platform,
				platform: platform,
				user: userId,
			});
			this.log("Created new device record:", deviceId);
		} catch (e: any) {
			// Record may already exist, try to update
			if (e.status === 400 || e.status === 409) {
				try {
					await pb.collection("devices").update(deviceId, {
						platform: platform,
						user: userId,
					});
					this.log("Updated existing device record:", deviceId);
				} catch (updateError) {
					this.error("Failed to update device:", updateError);
					throw updateError;
				}
			} else {
				throw e;
			}
		}
	}

	private async registerVault(
		vaultId: string,
		vaultName: string,
		deviceId: string,
		userId: string,
	): Promise<void> {
		const pb = this.loginManager.pb;

		try {
			// Try to create new vault record
			await pb.collection("vaults").create({
				id: vaultId,
				name: vaultName,
				device: deviceId,
				user: userId,
			});
			this.log("Created new vault record:", vaultId);
		} catch (e: any) {
			// Record may already exist, try to update
			if (e.status === 400 || e.status === 409) {
				try {
					await pb.collection("vaults").update(vaultId, {
						name: vaultName,
						device: deviceId,
					});
					this.log("Updated existing vault record:", vaultId);
				} catch (updateError) {
					this.error("Failed to update vault:", updateError);
					throw updateError;
				}
			} else {
				throw e;
			}
		}
	}

	override destroy(): void {
		super.destroy();
	}
}
