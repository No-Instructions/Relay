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

interface ServerFlags {
	name: string;
	value: boolean;
	override: boolean;
}

export class FeatureFlagManager extends Observable<FeatureFlagManager> {
	private static instance: FeatureFlagManager | null;
	private settings?: NamespacedSettings<FeatureFlags>;
	public flags: FeatureFlags;

	private constructor() {
		super("FeatureFlagManager");
		this.flags = FeatureFlagDefaults;
	}

	async applyServerFlags(serverFlags: ServerFlags[]) {
		if (!this.settings) return;

		const overrides = serverFlags.filter((flag) => flag.override);
		const flagsMap = overrides.reduce<Partial<FeatureFlags>>((acc, flag) => {
			acc[flag.name as keyof FeatureFlags] = flag.value;
			return acc;
		}, {});

		this.log("applying server flags", flagsMap);
		await this.settings.update(
			(current) => ({
				...current,
				...flagsMap,
			}),
			true,
		);

		return;
	}

	public static getInstance(): FeatureFlagManager {
		if (!FeatureFlagManager.instance) {
			FeatureFlagManager.instance = new FeatureFlagManager();
		}
		return FeatureFlagManager.instance;
	}

	public setSettings(settings: NamespacedSettings<FeatureFlags>) {
		this.settings = settings;
		this.unsubscribes.push(
			this.settings.subscribe((newFlags) => {
				this.flags = {
					...this.flags,
					...newFlags,
				};
				this.notifyListeners();
			}),
		);
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
		if (FeatureFlagManager.instance) {
			FeatureFlagManager.instance.destroy();
		}
		FeatureFlagManager.instance = null;
	}
}
