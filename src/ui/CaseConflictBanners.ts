import { Component, type App, type TextFileView, type TFile } from "obsidian";
import type { SharedFolder, SharedFolders } from "../SharedFolder";
import { iterateCanvasViews, type CanvasView } from "../CanvasView";
import { iterateTextFileViews, type TextViewRegistry } from "../TextViewRegistry";
import { caseConflictState } from "../caseConflictState";
import { Banner } from "./Banner";

type FileView = TextFileView | CanvasView;

/**
 * Warns on open files whose path, or a folder above it, conflicts in case with
 * another shared path. The warning is advisory: the file keeps syncing, so the
 * banner has its own slot beside whatever the live view shows.
 */
export class CaseConflictBanners extends Component {
	private banners = new Map<FileView, { path: string; label: string; banner: Banner }>();
	private watched = new WeakSet<SharedFolder>();
	private unloaded = false;

	constructor(
		private app: App,
		private folders: SharedFolders,
		private registry: TextViewRegistry,
	) { super(); }

	onload(): void {
		this.register(this.folders.subscribe(() => {
			this.folders.forEach(folder => this.watch(folder));
			this.refresh();
		}));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
	}

	onunload(): void {
		this.unloaded = true;
		this.banners.forEach(({ banner }) => banner.destroy());
		this.banners.clear();
	}

	/**
	 * Conflicts come and go with membership, and their wording with what this
	 * machine holds back; neither changes with any view event.
	 */
	private watch(folder: SharedFolder): void {
		if (this.watched.has(folder)) return;
		this.watched.add(folder);
		for (const unsubscribe of [
			folder.syncStore.subscribe(() => this.refresh()),
			folder.heldCasePaths.subscribe(() => this.refresh()),
		]) {
			this.register(unsubscribe);
			folder.onDestroy(unsubscribe);
		}
		folder.whenReady().then(() => this.refresh(), () => {});
	}

	private refresh(): void {
		if (this.unloaded) return;
		const wanted = new Map<FileView, { path: string; label: string }>();
		const consider = (view: FileView, file: TFile | null | undefined) => {
			if (!file) return;
			const folder = this.folders.lookup(file.path);
			const state = folder ? caseConflictState(folder, file) : null;
			if (state) wanted.set(view, { path: file.path, label: state.label });
		};
		iterateTextFileViews(this.app.workspace, this.registry, view => consider(view, view.file));
		iterateCanvasViews(this.app.workspace, view => consider(view, view.file));
		for (const [view, entry] of this.banners) {
			const next = wanted.get(view);
			if (next?.path !== entry.path || next.label !== entry.label) {
				entry.banner.destroy();
				this.banners.delete(view);
			}
		}
		for (const [view, { path, label }] of wanted) {
			if (this.banners.has(view)) continue;
			const banner = new Banner(view, { short: "Case conflict", long: label }, undefined, "relay-case-conflict");
			this.banners.set(view, { path, label, banner });
		}
	}
}
