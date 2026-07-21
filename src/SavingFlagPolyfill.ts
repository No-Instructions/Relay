import { HasLogging } from "./debug";
import { getPatcher } from "./Patcher";

/**
 * Obsidian's `Vault.modify` and `Vault.process` maintain the per-file
 * `saving` flag with remember/restore bookkeeping: each call stores the
 * flag value it saw on entry and writes that value back when it
 * finishes. Remember/restore is only correct when writer sections nest
 * like a stack. When two writes to the same file overlap, the later
 * writer remembers `true` and restores `true` after the last write
 * completes, leaving `saving` stuck on with no write in flight. The
 * flag's readers (the fs watcher and the editor load path) then treat
 * every external change to that file as a self-save, so external edits
 * stop being ingested until restart.
 *
 * This polyfill wraps both methods with per-file occupancy counting:
 * each wrapped call increments the count on entry and, after the
 * original call fully settles (its own restore included), converges the
 * flag to the count's truth — truthy while any write is in flight,
 * false once the last one finishes. The wrapped call is otherwise
 * untouched: arguments, return values, and exceptions pass through
 * unchanged, and there are no timers or forced clears.
 *
 * Arming is conditional on detecting the faulty idiom in the installed
 * implementation's source, so the polyfill stands down by itself on
 * versions that ship counter-based (or otherwise reworked) bookkeeping.
 */

/**
 * The minified remember/restore idiom (`i=e.saving,e.saving=!0`).
 * Counter-based bookkeeping (`e.saving=(e.saving||0)+1`) does not
 * match.
 */
export const BOOLEAN_RESTORE_IDIOM = /=\w+\.saving,\w+\.saving=!0/;

export function hasBooleanRestoreIdiom(source: string): boolean {
	return BOOLEAN_RESTORE_IDIOM.test(source);
}

export interface VaultWriteMethods {
	modify: (...args: any[]) => Promise<any>;
	process: (...args: any[]) => Promise<any>;
}

type Decision =
	| "armed"
	| "not-armed-flag-disabled"
	| "not-armed-looks-fixed"
	| "disarmed";

export class SavingFlagPolyfill extends HasLogging {
	private inFlight = new WeakMap<object, number>();
	private removePatch: (() => void) | null = null;
	private lastDecision: Decision | null = null;

	constructor(private target: VaultWriteMethods) {
		super("SavingFlagPolyfill");
	}

	get armed(): boolean {
		return this.removePatch !== null;
	}

	/** Arm or disarm to match the feature flag. Safe to call repeatedly. */
	setEnabled(enabled: boolean): void {
		if (!enabled) {
			if (this.removePatch) {
				this.disarm();
			} else {
				this.report(
					"not-armed-flag-disabled",
					"not armed: feature flag is disabled",
				);
			}
			return;
		}
		this.arm();
	}

	private arm(): void {
		if (this.removePatch) return;
		if (!hasBooleanRestoreIdiom(String(this.target.modify))) {
			this.report(
				"not-armed-looks-fixed",
				"standing down: the write-path idiom was not detected (either fixed upstream, or another plugin has already wrapped vault writes)",
			);
			return;
		}
		const wrap = this.wrapWithOccupancy;
		this.removePatch = getPatcher().patch(this.target, {
			modify: wrap,
			process: wrap,
		});
		this.report(
			"armed",
			"armed: boolean remember/restore idiom detected in Vault.modify",
		);
	}

	disarm(): void {
		if (!this.removePatch) return;
		this.removePatch();
		this.removePatch = null;
		this.report("disarmed", "disarmed");
	}

	/**
	 * Pure occupancy bookkeeping around the original method. The original
	 * runs unchanged; after it settles — its own finally (the stale
	 * boolean restore) included — the flag is overwritten with the
	 * count's truth. There is a single-microtask window between the
	 * original's restore and the correction; the fs watcher observes the
	 * flag from macrotasks and cannot see it.
	 */
	private wrapWithOccupancy = (original: (...args: any[]) => any) => {
		const inFlight = this.inFlight;
		return async function (this: unknown, file: any, ...args: any[]) {
			if (file === null || typeof file !== "object") {
				return original.call(this, file, ...args);
			}
			inFlight.set(file, (inFlight.get(file) ?? 0) + 1);
			try {
				return await original.call(this, file, ...args);
			} finally {
				const n = (inFlight.get(file) ?? 1) - 1;
				inFlight.set(file, n);
				file.saving = n > 0;
			}
		};
	};

	private report(decision: Decision, message: string): void {
		if (this.lastDecision === decision) return;
		this.lastDecision = decision;
		this.log(`saving-flag polyfill ${message}`);
	}
}
