import { Platform } from "obsidian";

export interface Device {
	is_mobile: boolean;
	is_pc: boolean;
	is_tablet: boolean;
	device_type: string;
	os: string;
	os_version: string;
	relay_version: string;
	last_seen: string;
}

export function generateRandomId(length: number = 15): string {
	const characters =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";

	for (let i = 0; i < length; i++) {
		const randomIndex = Math.floor(Math.random() * characters.length);
		result += characters.charAt(randomIndex);
	}

	return result;
}

export function generateName(): string {
	let name = "";
	if (Platform.isAndroidApp && Platform.isPhone) {
		name = "Android phone";
	} else if (Platform.isAndroidApp && Platform.isTablet) {
		name = "Android tablet";
	} else if (Platform.isLinux && Platform.isPhone) {
		name = "Linux phone";
	} else if (Platform.isLinux) {
		name = "Linux machine";
	} else if (Platform.isWin && Platform.isDesktopApp) {
		name = "Windows machine";
	} else if (Platform.isWin && Platform.isTablet) {
		name = "Windows tablet";
	} else if (Platform.isWin && Platform.isPhone) {
		name = "Windows phone";
	} else if (Platform.isMacOS && Platform.isDesktopApp) {
		name = "Mac";
	} else if (Platform.isIosApp && Platform.isPhone) {
		name = "iPhone";
	} else if (Platform.isIosApp && Platform.isTablet) {
		name = "iPad";
	} else if (Platform.isMobile) {
		name = "Mobile device";
	} else if (Platform.isDesktop) {
		name = "Machine";
	} else {
		name = "Device";
	}

	return name;
}
