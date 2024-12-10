import type { NamespacedSettings } from "./SettingsStorage";
import { type FeatureFlags, type Flag, FeatureFlagDefaults } from "./flags";
import { Observable } from "./observable/Observable";

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

export function withAnyOf(
	flags: Flag[],
	fn: () => void,
	otherwise: () => void = () => {},
) {
	flags.forEach((flag) => {
		if (FeatureFlagManager.getInstance().flags[flag]) {
			fn();
			return;
		}
	});
	otherwise();
}

export class FeatureFlagManager extends Observable<FeatureFlagManager> {
	private static instance: FeatureFlagManager | null;
	private settings?: NamespacedSettings<FeatureFlags>;
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

	public setSettings(settings: NamespacedSettings<FeatureFlags>) {
		this.settings = settings;
		this.settings.subscribe((newFlags) => {
			this.flags = {
				...this.flags,
				...newFlags,
			};
			this.notifyListeners();
		});
	}

	public getFlag(flagName: keyof FeatureFlags): boolean {
		return this.flags[flagName];
	}

	public setFlag(flagName: keyof FeatureFlags, value: boolean): void {
		if (!this.settings) return;

		this.settings.update((current) => ({
			...current,
			[flagName]: value,
		}));
	}

	public static destroy() {
		FeatureFlagManager.instance = null;
	}
}
