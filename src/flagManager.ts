import { type FeatureFlags, type Flag, FeatureFlagDefaults } from "./flags";
import { Observable } from "./observable/Observable";
import { PostOffice } from "./observable/Postie";

export function flags(): FeatureFlags {
	return { ...FeatureFlagManager.getInstance().flags };
}
export function withFlag(
	flag: Flag,
	fn: () => void,
	otherwise: () => void = () => {},
): void {
	if (FeatureFlagManager.getInstance().flags[flag]) {
		fn();
	} else {
		otherwise();
	}
}

export class FeatureFlagManager extends Observable<FeatureFlagManager> {
	private static instance: FeatureFlagManager | null;
	public flags: FeatureFlags;

	private constructor() {
		super();
		this.flags = FeatureFlagDefaults;
	}

	public static getInstance(): FeatureFlagManager {
		if (!FeatureFlagManager.instance) {
			FeatureFlagManager.instance = new FeatureFlagManager();
		}
		return FeatureFlagManager.instance;
	}

	public async setFlags(flags: FeatureFlags, notify = false): Promise<void> {
		const validFlags = Object.keys(this.flags).reduce((acc, key) => {
			if (key in flags) {
				acc[key as keyof FeatureFlags] = flags[key as keyof FeatureFlags]!;
			}
			return acc;
		}, {} as FeatureFlags);

		if (this.flags === validFlags) {
			return;
		}
		this.flags = { ...this.flags, ...validFlags };
		if (notify) {
			this.notifyListeners();
		}
	}

	public getFlag(flagName: keyof FeatureFlags): boolean {
		return this.flags[flagName];
	}

	public setFlag(
		flagName: keyof FeatureFlags,
		value: boolean,
		notify = false,
	): void {
		this.flags[flagName] = value;
		if (notify) {
			this.notifyListeners();
		}
	}

	public static destroy() {
		FeatureFlagManager.instance = null;
	}
}
