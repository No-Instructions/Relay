import { Component, ItemView, MarkdownRenderer, type Workspace, type ViewStateResult } from "obsidian";
import { readMessageActions, type ServiceMessageAction } from "../ServiceMessages";
import { requestUrlWithMetrics } from "../customFetch";

export const SERVICE_MESSAGE_VIEW = "system3-relay-service-message";
type MarkdownAction = Extract<ServiceMessageAction, { type: "markdown" }>;
const MAX_MARKDOWN_BYTES = 512 * 1024;

export async function loadMessageMarkdown(action: MarkdownAction, signal: AbortSignal): Promise<string> {
	if (action.markdown !== undefined) return action.markdown;
	if (signal.aborted) throw new Error("Loading cancelled");
	let onAbort: () => void;
	const cancelled = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("Loading cancelled or timed out"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const response = await Promise.race([
			requestUrlWithMetrics({ url: action.url, method: "GET", throw: false, signal, maxResponseBytes: MAX_MARKDOWN_BYTES }),
			cancelled,
		]);
		if (response.status !== 200) throw new Error(`The note could not be loaded (HTTP ${response.status}).`);
		if (response.arrayBuffer.byteLength > MAX_MARKDOWN_BYTES) throw new Error("The note is too large to display.");
		return response.text;
	} finally {
		signal.removeEventListener("abort", onAbort!);
	}
}

export class ServiceMessageView extends ItemView {
	private action?: MarkdownAction;
	private generation = 0;
	private controller?: AbortController;
	private renderOwner?: Component;

	getViewType(): string { return SERVICE_MESSAGE_VIEW; }
	getDisplayText(): string { return this.action?.label ?? "Relay message"; }
	getIcon(): string { return "file-text"; }
	getState(): Record<string, unknown> { return this.action ? { action: this.action } : {}; }

	async setState(state: { action?: unknown }, result: ViewStateResult): Promise<void> {
		const action = readMessageActions([state?.action])[0];
		this.action = action?.type === "markdown" ? action : undefined;
		this.renderInBackground();
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> { this.renderInBackground(); }
	async onClose(): Promise<void> { this.clearRender(); }

	private renderInBackground(): void {
		void this.renderNote().catch((error: unknown) => {
			console.error("Service message render failed", error);
		});
	}

	private clearRender(): void {
		this.generation++;
		this.controller?.abort();
		this.controller = undefined;
		if (this.renderOwner) this.removeChild(this.renderOwner);
		this.renderOwner = undefined;
		this.contentEl.empty();
	}

	private async renderNote(): Promise<void> {
		this.clearRender();
		this.contentEl.addClass("markdown-preview-view", "system3-service-message-view");
		const body = this.contentEl.createDiv({ cls: "markdown-preview-sizer markdown-rendered" });
		const action = this.action;
		if (!action) { body.createEl("p", { text: "No message selected." }); return; }
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		const timer = window.setTimeout(() => controller.abort(), 30_000);
		body.createEl("p", { text: "Loading…" });
		try {
			const markdown = await loadMessageMarkdown(action, controller.signal);
			if (generation !== this.generation) return;
			body.empty();
			const owner = new Component();
			this.renderOwner = owner;
			this.addChild(owner);
			await MarkdownRenderer.render(this.app, markdown, body, "", owner);
		} catch (error) {
			if (generation !== this.generation) return;
			body.empty();
			body.createEl("p", { text: error instanceof Error ? error.message : "The note could not be loaded." });
			const retry = body.createEl("button", { text: "Retry" });
			retry.addEventListener("click", () => this.renderInBackground(), { once: true });
		} finally {
			window.clearTimeout(timer);
			if (this.controller === controller) this.controller = undefined;
		}
	}
}

export async function openServiceMessageView(workspace: Workspace, action: MarkdownAction): Promise<void> {
	const leaf = workspace.getLeaf("tab");
	await leaf.setViewState({ type: SERVICE_MESSAGE_VIEW, active: true, state: { action } });
	await workspace.revealLeaf(leaf);
}
