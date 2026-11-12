"use strict";

import {
	registerDevice,
	registerVault,
} from "../packages/relay-auth/src/registration";

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
		private loginManager: LoginManager,
	) {
		super("DeviceManager");
	}

	/**
	 * Get or create the device ID from localStorage.
	 */
	getDeviceId(): string {
		if (this.deviceId) return this.deviceId;

		// The device id identifies this installation across every vault, so it
		// lives in localStorage rather than App's vault-scoped storage.
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
			await registerDevice(
				this.loginManager.pb,
				(...values) => this.log(...values),
				deviceId,
				platform,
				userId,
				(...values) => this.error(...values),
			);

			// Register vault
			await registerVault(
				this.loginManager.pb,
				(...values) => this.log(...values),
				this.appId,
				deviceId,
				userId,
				(...values) => this.error(...values),
			);

			this.registered = true;
			this.log("Device and vault registered successfully");
		} catch (error) {
			this.error("Failed to register device/vault:", error);
		}
	}

	override destroy(): void {
		super.destroy();
	}
}
