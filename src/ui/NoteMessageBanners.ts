import { Component, Modal, type App, type TextFileView } from "obsidian";
import type { SharedFolders } from "../SharedFolder";
import { iterateTextFileViews, type TextViewRegistry } from "../TextViewRegistry";
import type { ServiceMessage, ServiceMessageAction, ServiceMessages } from "../ServiceMessages";
import ServiceMessageNote from "../components/ServiceMessageNote.svelte";
import { Banner } from "./Banner";
import { mountComponent } from "./svelteHost.svelte";

/** Service notices follow shared notes even while their folder cannot connect. */
export class NoteMessageBanners extends Component {
	private message: ServiceMessage | null = null;
	private banners = new Map<TextFileView, { path: string; content: string; banner: Banner }>();
	private modals = new Set<Modal>();

	constructor(
		private app: App,
		private messages: ServiceMessages,
		private folders: SharedFolders,
		private registry: TextViewRegistry,
		private onAction: (action: ServiceMessageAction) => void,
	) { super(); }

	onload(): void {
		this.register(this.messages.subscribe(message => {
			if (this.message?.id !== message?.id) this.modals.forEach(modal => modal.close());
			this.message = message;
			this.refresh();
		}, "note"));
		this.register(this.folders.subscribe(() => this.refresh()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
	}

	onunload(): void {
		this.modals.forEach(modal => modal.close());
		this.banners.forEach(({ banner }) => banner.destroy());
		this.banners.clear();
		this.message = null;
	}

	private refresh(): void {
		const message = this.message;
		const content = JSON.stringify(message);
		const views = new Set<TextFileView>();
		if (message) iterateTextFileViews(this.app.workspace, this.registry, view => {
			if (view.file && this.folders.lookup(view.file.path)) views.add(view);
		});
		for (const [view, entry] of this.banners) {
			if (!views.has(view) || entry.path !== view.file?.path || entry.content !== content) {
				entry.banner.destroy();
				this.banners.delete(view);
			}
		}
		if (!message) return;
		for (const view of views) {
			const current = this.banners.get(view);
			if (current) { current.banner.display(); continue; }
			const banner = new Banner(view, { short: message.title, long: `${message.title}: ${message.message}` }, async () => {
				const modal = new Modal(this.app);
				this.modals.add(modal);
				const component = mountComponent(ServiceMessageNote, {
					target: modal.contentEl,
					props: {
						message,
						onAction: (action: ServiceMessageAction) => { modal.close(); this.onAction(action); },
						onDismiss: () => this.messages.dismiss(message.id),
					},
				});
				modal.onClose = () => { component.destroy(); this.modals.delete(modal); };
				modal.open();
				return false;
			}, {
				priority: 1,
				backgroundColor: message.backgroundColor ?? "color-mix(in srgb, var(--interactive-accent) 12%, var(--background-primary))",
				color: message.color ?? "var(--text-normal)",
				render: target => {
					const component = mountComponent(ServiceMessageNote, {
						target, props: { message, onAction: this.onAction, onDismiss: () => this.messages.dismiss(message.id) },
					});
					return () => component.destroy();
				},
			});
			this.banners.set(view, { path: view.file!.path, content, banner });
		}
	}
}
