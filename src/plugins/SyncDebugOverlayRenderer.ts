import type { MarkdownView } from "obsidian";
import type { Document } from "../Document";
import type { MergeTransitionInfo } from "../merge-hsm/MergeManager";
import type { ViewRenderer } from "./ViewRenderer";
import {
	readSyncDebugGate,
	shapeSyncDebugSnapshot,
	type SyncDebugGateSnapshot,
	type SyncDebugSnapshot,
} from "../ui/SyncDebugSnapshot";

interface LastEvent {
	type: string;
	at: number;
}

export interface SyncDebugSegment {
	text: string;
	className?: string;
	title?: string;
}

/** View-scoped, read-only diagnostic strip for one shared Markdown document. */
export class SyncDebugOverlayRenderer implements ViewRenderer {
	private overlayElement: HTMLElement | null = null;
	private readonly unsubscribes: Array<() => void> = [];
	private intervalId: number | null = null;
	private intervalWindow: Window | null = null;
	private pendingOutboundSince: number | null = null;
	private editorLocalMismatch: boolean | null = null;
	private editorLocalMismatchSince: number | null = null;
	private diskStat: { mtime: number | null } | null = null;
	private diskStatProbeInFlight = false;
	private lastEvent: LastEvent | null = null;
	private lastSignature = "";
	private renderQueued = false;
	private destroyed = false;

	constructor(
		private view: MarkdownView,
		private relayDocument: Document,
	) {
		this.mount();
		this.subscribe();
		this.render(this.relayDocument, "unknown");
	}

	render(_document: Document, _viewMode: string): void {
		this.renderQueued = false;
		if (this.destroyed || !this.overlayElement) return;

		try {
			const now = this.now();
			const hsm = this.relayDocument?.hsm;
			const state = hsm?.state;
			const syncGate = readSyncDebugGate(this.providerConnected(), hsm);
			this.trackPendingOutbound(now, syncGate);

			const snapshot = shapeSyncDebugSnapshot({
				now,
				statePath: state?.statePath,
				syncGate,
				pendingOutboundSince: this.pendingOutboundSince,
				websocketLastMessageAt: this.websocketLastMessageAt(),
				diskHsm: state?.disk
					? { hash: state.disk.hash, mtime: state.disk.mtime }
					: null,
				diskStat: this.diskStat,
				lca: state?.lca
					? {
							hash: state.lca.meta.hash,
							contentLength:
								typeof state.lca.contents === "string"
									? state.lca.contents.length
									: null,
					}
					: null,
				fork: state?.fork ? { created: state.fork.created } : null,
				error: state?.error
					? {
							message: state.error.message,
							retryable: state.errorRetryable ?? null,
					}
					: null,
				lastEvent: this.lastEvent,
				editorLocalMismatch: this.editorLocalMismatch,
				editorLocalMismatchSince: this.editorLocalMismatchSince,
			});

			this.renderSnapshot(snapshot);
		} catch (error) {
			this.renderUnavailable(error);
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.renderQueued = false;

		for (const unsubscribe of this.unsubscribes.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// The owning document may already be partially destroyed.
			}
		}
		if (this.intervalId !== null) {
			this.intervalWindow?.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.intervalWindow = null;
		this.overlayElement?.remove();
		this.overlayElement = null;
		this.view = null as any;
		this.relayDocument = null as any;
	}

	private mount(): void {
		const container = this.view?.containerEl;
		if (!container) return;

		const overlay = container.ownerDocument.createElement("div");
		overlay.className = "system3-sync-debug-overlay";
		overlay.setAttribute("role", "status");
		overlay.setAttribute("aria-live", "off");
		overlay.setAttribute("aria-label", "Relay document sync diagnostics");

		const content = container.querySelector(".view-content");
		const reference =
			content?.parentNode === container ? content : container.firstChild;
		container.insertBefore(overlay, reference);
		this.overlayElement = overlay;

		const intervalWindow = container.ownerDocument.defaultView;
		if (intervalWindow) {
			this.intervalWindow = intervalWindow;
			this.intervalId = intervalWindow.setInterval(() => {
				this.tick();
			}, 1_000);
		}
	}

	private subscribe(): void {
		try {
			const hsm = this.relayDocument?.hsm;
			if (hsm) {
				this.unsubscribes.push(
					hsm.stateChanges.subscribe(() => {
						this.requestRender();
					}),
				);
			}
		} catch {
			// The interval still supplies a best-effort view for a loading HSM.
		}

		try {
			const guid = this.relayDocument.guid;
			const manager = this.relayDocument.sharedFolder?.mergeManager;
			if (manager) {
				this.unsubscribes.push(
					manager.subscribeToTransitions(
						(eventGuid: string, _path: string, info: MergeTransitionInfo) => {
							if (eventGuid !== guid || this.destroyed) return;
							this.lastEvent = { type: info.event.type, at: this.now() };
							this.requestRender();
						},
					),
				);
			}
		} catch {
			// Transition observation is optional while a folder is constructing.
		}

		try {
			this.unsubscribes.push(
				this.relayDocument.subscribe(this, () => {
					this.requestRender();
				}),
			);
		} catch {
			// Provider notifications may be unavailable during teardown.
		}
	}

	requestRender(): void {
		if (this.destroyed || this.renderQueued) return;
		this.renderQueued = true;
		Promise.resolve().then(() => {
			if (!this.renderQueued || this.destroyed) return;
			this.render(this.relayDocument, "unknown");
		});
	}

	private tick(): void {
		if (this.destroyed) return;
		this.refreshEditorLocalMismatch(this.now());
		this.requestRender();
		void this.probeDiskStat();
	}

	private async probeDiskStat(): Promise<void> {
		if (this.destroyed || this.diskStatProbeInFlight) return;
		this.diskStatProbeInFlight = true;

		try {
			const document = this.relayDocument;
			const adapter = document?.vault?.adapter;
			const path = document?.sharedFolder?.getPath?.(document.path);
			if (!adapter || typeof path !== "string") {
				if (!this.destroyed) this.diskStat = null;
				return;
			}

			const stat = await adapter.stat(path);
			if (this.destroyed) return;
			this.diskStat = {
				mtime:
					typeof stat?.mtime === "number" && Number.isFinite(stat.mtime)
						? stat.mtime
						: null,
			};
		} catch {
			if (!this.destroyed) this.diskStat = null;
		} finally {
			this.diskStatProbeInFlight = false;
			this.requestRender();
		}
	}

	private now(): number {
		try {
			const value = this.relayDocument?.timeProvider?.now();
			if (typeof value === "number" && Number.isFinite(value)) return value;
		} catch {
			// Fall through to the wall clock.
		}
		return Date.now();
	}

	private providerConnected(): boolean {
		try {
			return this.relayDocument?.connected === true;
		} catch {
			return false;
		}
	}

	private websocketLastMessageAt(): number | null {
		try {
			const value = this.relayDocument?._provider?.wsLastMessageReceived;
			return typeof value === "number" && Number.isFinite(value) && value > 0
				? value
				: null;
		} catch {
			return null;
		}
	}

	private refreshEditorLocalMismatch(now: number): void {
		try {
			const editorText = (this.view?.editor as any)?.cm?.state?.doc;
			const localText = this.relayDocument?.localDoc?.getText("contents");
			if (!editorText || !localText) {
				this.setEditorLocalMismatch(null, now);
				return;
			}
			const editorLength = editorText?.length;
			const localLength = localText?.length;
			if (
				typeof editorLength !== "number" ||
				!Number.isFinite(editorLength) ||
				typeof localLength !== "number" ||
				!Number.isFinite(localLength)
			) {
				this.setEditorLocalMismatch(null, now);
				return;
			}

			const mismatch =
				editorLength !== localLength ||
				editorText.toString() !== localText.toString();
			this.setEditorLocalMismatch(mismatch, now);
		} catch {
			this.setEditorLocalMismatch(null, now);
		}
	}

	private setEditorLocalMismatch(
		mismatch: boolean | null,
		now: number,
	): void {
		this.editorLocalMismatch = mismatch;
		if (mismatch === true) {
			this.editorLocalMismatchSince ??= now;
		} else {
			this.editorLocalMismatchSince = null;
		}
	}

	private trackPendingOutbound(
		now: number,
		syncGate: SyncDebugGateSnapshot | null,
	): void {
		if (syncGate?.providerSynced && syncGate.pendingOutbound > 0) {
			this.pendingOutboundSince ??= now;
			return;
		}
		this.pendingOutboundSince = null;
	}

	private renderSnapshot(snapshot: SyncDebugSnapshot): void {
		const segments = buildSyncDebugSegments(snapshot);
		const signature = JSON.stringify(segments);
		if (signature === this.lastSignature) return;
		this.lastSignature = signature;

		const overlay = this.overlayElement;
		if (!overlay) return;
		overlay.classList.toggle(
			"has-drift",
			Object.values(snapshot.drift).some(Boolean),
		);
		const elements = segments.map((segment) => {
			const span = overlay.ownerDocument.createElement("span");
			span.className = `system3-sync-debug-segment${
				segment.className ? ` ${segment.className}` : ""
			}`;
			span.textContent = segment.text;
			if (segment.title) span.title = segment.title;
			return span;
		});
		overlay.replaceChildren(...elements);
	}

	private renderUnavailable(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const signature = `unavailable:${message}`;
		if (!this.overlayElement || signature === this.lastSignature) return;
		this.lastSignature = signature;
		this.overlayElement.classList.add("has-drift");
		this.overlayElement.textContent = `sync debug unavailable: ${compact(message, 160)}`;
	}
}

export function buildSyncDebugSegments(
	snapshot: SyncDebugSnapshot,
): SyncDebugSegment[] {
	const stateClass = snapshot.error || snapshot.statePath.includes("error")
		? "is-error"
		: snapshot.fork.present
			? "is-fork"
			: undefined;
	const gate = snapshot.syncGate;
	const segments: SyncDebugSegment[] = [
		{ text: `hsm ${snapshot.statePath}`, className: stateClass },
		{
			text: gate
				? `gate in:${gate.pendingInbound} out:${gate.pendingOutbound} synced:${yesNo(gate.providerSynced)} local:${yesNo(gate.localOnly)}`
				: "gate -",
			className: snapshot.drift.providerOutboundStuck ? "is-drift" : undefined,
		},
		{
			text: `ws conn:${yesNo(snapshot.transport.connected)} msg:${formatAge(snapshot.transport.lastMessageAgeMs)}`,
		},
	];

	segments.push(
		snapshot.diskHsm
			? {
					text: `disk(hsm) m:${formatTimestamp(snapshot.diskHsm.mtime)} h:${snapshot.diskHsm.hash ?? "-"} match:${yesNo(snapshot.diskHsm.matchesLca)}`,
					className:
						snapshot.drift.diskHsmLca || snapshot.drift.diskHsmStat
							? "is-drift"
							: undefined,
					title: snapshot.diskHsm.fullHash
						? `HSM disk hash ${snapshot.diskHsm.fullHash}`
						: undefined,
			}
			: { text: "disk(hsm) -" },
		snapshot.diskStat
			? {
					text: `disk(stat) m:${formatTimestamp(snapshot.diskStat.mtime)}`,
					className: snapshot.drift.diskHsmStat ? "is-drift" : undefined,
			}
			: { text: "disk(stat) -" },
		snapshot.lca
			? {
					text: `lca h:${snapshot.lca.hash ?? "-"} len:${snapshot.lca.contentLength ?? "-"}`,
					title: snapshot.lca.fullHash
						? `LCA hash ${snapshot.lca.fullHash}`
						: undefined,
			}
			: { text: "lca -" },
		{
			text: snapshot.fork.present
				? `fork yes age:${formatAge(snapshot.fork.ageMs)}`
				: "fork no",
			className: snapshot.fork.present ? "is-fork" : undefined,
		},
		{
			text: snapshot.lastEvent
				? `event ${snapshot.lastEvent.type} age:${formatAge(snapshot.lastEvent.ageMs)}`
				: "event -",
		},
	);

	if (snapshot.error || snapshot.statePath.includes("error")) {
		segments.push({
			text: snapshot.error
				? `error ${compact(snapshot.error.message, 160)} retry:${yesNo(snapshot.error.retryable)}`
				: "error - retry:-",
			className: "is-error",
			title: snapshot.error?.message,
		});
	}
	if (snapshot.drift.diskHsmLca) {
		segments.push({
			text: "DRIFT disk(hsm)≠lca",
			className: "is-drift",
		});
	}
	if (snapshot.drift.diskHsmStat) {
		segments.push({
			text: "DRIFT disk(hsm)≠disk(stat)",
			className: "is-drift",
		});
	}
	if (snapshot.drift.editorLocal) {
		segments.push({ text: "DRIFT editor≠local", className: "is-drift" });
	}
	if (snapshot.drift.providerOutboundStuck) {
		segments.push({
			text: `DRIFT synced+out age:${formatAge(gate?.pendingOutboundAgeMs ?? null)}`,
			className: "is-drift",
		});
	}

	return segments;
}

function yesNo(value: boolean | null): string {
	return value === null ? "-" : value ? "y" : "n";
}

function formatAge(ageMs: number | null): string {
	if (ageMs === null) return "-";
	const quantizedAgeMs = Math.floor(ageMs / 100) * 100;
	if (quantizedAgeMs < 1_000) return `${quantizedAgeMs}ms`;
	if (quantizedAgeMs < 10_000) {
		return `${(quantizedAgeMs / 1_000).toFixed(1)}s`;
	}
	if (quantizedAgeMs < 60_000) {
		return `${Math.floor(quantizedAgeMs / 1_000)}s`;
	}
	if (quantizedAgeMs < 3_600_000) {
		return `${Math.floor(quantizedAgeMs / 60_000)}m`;
	}
	return `${Math.floor(quantizedAgeMs / 3_600_000)}h`;
}

function formatTimestamp(timestamp: number | null): string {
	if (timestamp === null) return "-";
	try {
		return new Date(timestamp).toISOString();
	} catch {
		return String(timestamp);
	}
}

function compact(value: string, maxLength: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLength
		? `${oneLine.slice(0, maxLength - 1)}…`
		: oneLine;
}
