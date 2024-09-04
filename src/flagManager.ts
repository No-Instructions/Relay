import { type FeatureFlags, type Flag, FeatureFlagDefaults } from "./flags";

export function flags(): FeatureFlags {
	return { ...FeatureFlagManager.getInstance().flags };
}
export function withFlag(flag: Flag, fn: () => void): void {
	if (FeatureFlagManager.getInstance().flags[flag]) {
		fn();
	}
}

export class FeatureFlagManager {
	private static instance: FeatureFlagManager | null;
	public flags: FeatureFlags;

	private constructor() {
		this.flags = FeatureFlagDefaults;
	}

	public static getInstance(): FeatureFlagManager {
		if (!FeatureFlagManager.instance) {
			FeatureFlagManager.instance = new FeatureFlagManager();
		}
		return FeatureFlagManager.instance;
	}

	public async setFlags(flags: FeatureFlags): Promise<void> {
		const validFlags = Object.keys(this.flags).reduce((acc, key) => {
			if (key in flags) {
				acc[key as keyof FeatureFlags] = flags[key as keyof FeatureFlags]!;
			}
			return acc;
		}, {} as FeatureFlags);

		this.flags = { ...this.flags, ...validFlags };
	}

	public getFlag(flagName: keyof FeatureFlags): boolean {
		return this.flags[flagName];
	}

	public setFlag(flagName: keyof FeatureFlags, value: boolean): void {
		this.flags[flagName] = value;
	}

	public static destroy() {
		FeatureFlagManager.instance = null;
	}
}
