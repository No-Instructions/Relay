// Adapted from https://github.com/friebetill/obsidian-file-diff
//
// MIT License
//
// Copyright (c) 2022 Till Friebe
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { structuredPatch, diffWords } from "diff";
import {
	Workspace,
	ItemView,
	TFile,
	type ViewStateResult,
	WorkspaceLeaf,
	TextFileView,
} from "obsidian";
import { diffMatchPatch } from "src/y-diffMatchPatch";
import { Difference } from "./difference";
import { FileDifferences } from "./fileDifferences";
import { preventEmptyString } from "./stringUtils";
import { ActionLine } from "./actionLine";
import { Document } from "src/Document";
import { DiskBuffer } from "src/DiskBuffer";
import { ActionLineButton } from "./actionLineButton";
import { ActionLineDivider } from "./actionLineDivider";
import { flags } from "src/flagManager";
import { curryLog } from "src/debug";

export const VIEW_TYPE_DIFFERENCES = "system3-differences-view";

export interface ViewState {
	file1: TFile;
	file2: TFile;
	showMergeOption: boolean;
	onResolve?: () => Promise<void>;
	originalLeaf?: WorkspaceLeaf;
	[key: string]: unknown;
}

export async function openDiffView(
	workspace: Workspace,
	state: ViewState,
): Promise<void> {
	// Capture the currently active leaf to return to it later
	if (!state.originalLeaf) {
		state.originalLeaf = workspace.activeLeaf || undefined;
	}

	// Closes all leafs (views) of the type VIEW_TYPE_DIFFERENCES
	workspace.detachLeavesOfType(VIEW_TYPE_DIFFERENCES);

	// Opens a new leaf (view) of the type VIEW_TYPE_DIFFERENCES
	const leaf = workspace.getLeaf(true);
	leaf.setViewState({
		type: VIEW_TYPE_DIFFERENCES,
		active: true,
		state,
	});
	workspace.revealLeaf(leaf);
}

export class DifferencesView extends ItemView {
	private state?: ViewState;
	private file1Content?: string;
	private file2Content?: string;
	private fileDifferences?: FileDifferences;
	private file1Lines: string[] = [];
	private file2Lines: string[] = [];
	protected log;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		const logContext = this.constructor.name;
		this.log = curryLog(`[${logContext}]`, "log");
	}

	async getContent(file: TFile): Promise<string> {
		if (file instanceof Document) {
			return file.text;
		} else if (file instanceof DiskBuffer) {
			return file.contents;
		}
		return await this.app.vault.read(file);
	}

	override getViewType(): string {
		return VIEW_TYPE_DIFFERENCES;
	}

	override getDisplayText(): string {
		if (this.state?.file1 && this.state?.file2) {
			return (
				`File Diff: ${this.state.file1.name} ` + `and ${this.state.file2.name}`
			);
		}
		return `File Diff`;
	}

	override async setState(
		state: ViewState,
		result: ViewStateResult,
	): Promise<void> {
		super.setState(state, result);
		this.state = state;

		await this.updateState();
		this.build();
	}

	async onunload(): Promise<void> {
		this.state?.onResolve?.();
	}

	private closeAndReturnToOriginal(): void {
		// Return to original leaf if available and still valid
		if (this.state?.originalLeaf && this.state.originalLeaf.parent) {
			this.app.workspace.setActiveLeaf(this.state.originalLeaf, { focus: true });
		}
		this.leaf.detach();
	}

	private async updateState(): Promise<void> {
		if (this.state?.file1 == null || this.state?.file2 == null) {
			return;
		}

		this.file1Content = await this.getContent(this.state.file1);
		this.file2Content = await this.getContent(this.state.file2);

		this.file1Lines = this.file1Content
			// Add trailing new line as this removes edge cases
			.concat("\n")
			.split("\n")
			// Streamline empty spaces at the end as this remove edge cases
			.map((line) => line.trimEnd());

		this.file2Lines = this.file2Content
			// Add trailing new spaces as this removes edge cases
			.concat("\n")
			.split("\n")
			// Streamline empty lines at the end as this remove edge cases
			.map((line) => line.trimEnd());

		const parsedDiff = structuredPatch(
			this.state.file1.path,
			this.state.file2.path,
			this.file1Lines.join("\n"),
			this.file2Lines.join("\n"),
		);
		this.fileDifferences = FileDifferences.fromParsedDiff(parsedDiff);

		if (this.fileDifferences.differences.length === 0) {
			if (this.file1Content !== this.file2Content) {
				this.log(
					"byte level difference with differ equivalence",
					this.file1Content.length,
					this.file2Content.length,
				);
				if (flags().enableDeltaLogging) {
					// Iterate through each byte and print location and byte if they don't match
					const content1 = this.file1Content || "";
					const content2 = this.file2Content || "";
					const maxLength = Math.max(content1.length, content2.length);

					for (let i = 0; i < maxLength; i++) {
						const byte1 =
							i < content1.length ? content1.charCodeAt(i) : undefined;
						const byte2 =
							i < content2.length ? content2.charCodeAt(i) : undefined;

						if (byte1 !== byte2) {
							const hex1 =
								byte1 !== undefined
									? `0x${byte1.toString(16).padStart(2, "0")}`
									: "EOF";
							const hex2 =
								byte2 !== undefined
									? `0x${byte2.toString(16).padStart(2, "0")}`
									: "EOF";
							this.log(
								`Byte difference at position ${i}: file1=${byte1} (${hex1}), file2=${byte2} (${hex2})`,
							);
						}
					}
				}
				await this.modify(this.state.file2, this.file1Content || "");
			}
			this.closeAndReturnToOriginal();
		}
	}

	private build(): void {
		this.contentEl.empty();

		const container = this.contentEl.createDiv({
			cls: "file-diff__container",
		});

		this.buildHeader(container);
		this.buildLines(container);
		this.scrollToFirstDifference();
	}

	private update(): void {
		const scrollTop = this.contentEl.scrollTop;

		this.contentEl.empty();

		const container = this.contentEl.createDiv({
			cls: "file-diff__container",
		});

		this.buildHeader(container);
		this.buildLines(container);

		this.contentEl.scrollTop = scrollTop;
	}

	private buildHeader(container: HTMLDivElement): void {
		// Create action line similar to the existing ones
		const actionLine = container.createDiv({
			cls: "flex flex-row gap-1 py-0-5",
		});

		// Left file (top)
		new ActionLineButton({
			text: `Keep Editor Contents`,
			onClick: async (e) => {
				e.preventDefault();
				await this.acceptAllFromLeft();
			},
		}).build(actionLine);

		ActionLineDivider.build(actionLine);

		// Right file (bottom)
		new ActionLineButton({
			text: `Accept All from Local Disk`,
			onClick: async (e) => {
				e.preventDefault();
				await this.acceptAllFromRight();
			},
		}).build(actionLine);
	}

	async modify(file: TFile, newContent: string): Promise<void> {
		if (file instanceof Document) {
			diffMatchPatch(file.ydoc, newContent, this);
			return;
		} else if (file instanceof DiskBuffer) {
			file.contents = newContent;
			return;
		}
		await this.app.vault.modify(file, newContent);
	}

	private async acceptAllFromLeft(): Promise<void> {
		if (!this.state || !this.fileDifferences) return;
		await this.modify(this.state.file2, this.file1Content || "");
		await this.state.onResolve?.();
		this.closeAndReturnToOriginal();
	}

	private async acceptAllFromRight(): Promise<void> {
		if (!this.state || !this.fileDifferences) return;
		await this.modify(this.state.file1, this.file2Content || "");
		await this.state.onResolve?.();
		this.closeAndReturnToOriginal();
	}

	private buildLines(container: HTMLDivElement): void {
		let lineCount1 = 0;
		let lineCount2 = 0;
		const maxLineCount = Math.max(
			this.file1Lines?.length || 0,
			this.file2Lines?.length || 0,
		);
		while (lineCount1 <= maxLineCount || lineCount2 <= maxLineCount) {
			const difference = this.fileDifferences?.differences.find(
				// eslint-disable-next-line no-loop-func
				(d) => d.file1Start === lineCount1 && d.file2Start === lineCount2,
			);

			if (difference != null) {
				const differenceContainer = container.createDiv({
					cls: "difference",
				});
				this.buildDifferenceVisualizer(differenceContainer, difference);
				lineCount1 += difference.file1Lines.length;
				lineCount2 += difference.file2Lines.length;
			} else {
				const line =
					lineCount1 <= lineCount2
						? this.file1Lines[lineCount1]
						: this.file2Lines[lineCount2];
				container.createDiv({
					// Necessary to give the line a height when it's empty.
					text: preventEmptyString(line),
					cls: "file-diff__line",
				});
				lineCount1 += 1;
				lineCount2 += 1;
			}
		}
	}

	private buildDifferenceVisualizer(
		container: HTMLDivElement,
		difference: Difference,
	): void {
		if (this.state?.showMergeOption) {
			new ActionLine(this.app, {
				difference,
				file1: this.state.file1,
				file2: this.state.file2,
				file1Content: this.file1Content || "",
				file2Content: this.file2Content || "",
				triggerRebuild: async (): Promise<void> => {
					await this.updateState();
					this.update();
				},
			}).build(container);
		}

		// Draw top diff
		for (let i = 0; i < difference.file1Lines.length; i += 1) {
			const line1 = difference.file1Lines[i];
			const line2 = difference.file2Lines[i];

			const lineDiv = container.createDiv({
				cls: "file-diff__line file-diff__top-line__bg",
			});
			const diffSpans = this.buildDiffLine(
				line1,
				line2,
				"file-diff_top-line__character",
			);

			// Remove border radius if applicable
			if (
				i < difference.file1Lines.length - 1 ||
				difference.file2Lines.length !== 0
			) {
				lineDiv.classList.add("file-diff__no-bottom-border");
			}
			if (i !== 0) {
				lineDiv.classList.add("file-diff__no-top-border");
			}

			lineDiv.appendChild(diffSpans);
		}

		// Draw bottom diff
		for (let i = 0; i < difference.file2Lines.length; i += 1) {
			const line1 = difference.file1Lines[i];
			const line2 = difference.file2Lines[i];

			const lineDiv = container.createDiv({
				cls: "file-diff__line file-diff__bottom-line__bg",
			});
			const diffSpans = this.buildDiffLine(
				line2,
				line1,
				"file-diff_bottom-line__character",
			);

			// Remove border radius if applicable
			if ((i == 0 && difference.file1Lines.length > 0) || i > 0) {
				lineDiv.classList.add("file-diff__no-top-border");
			}
			if (i < difference.file2Lines.length - 1) {
				lineDiv.classList.add("file-diff__no-bottom-border");
			}

			lineDiv.appendChild(diffSpans);
		}
	}

	private buildDiffLine(line1: string, line2: string, charClass: string) {
		const fragment = document.createElement("div");

		if (line1 != undefined && line1.length === 0) {
			fragment.textContent = preventEmptyString(line1);
		} else if (line1 != undefined && line2 != undefined) {
			const differences = diffWords(line2, line1);

			for (const difference of differences) {
				if (difference.removed) {
					continue;
				}

				const span = document.createElement("span");
				// Necessary to give the line a height when it's empty.
				span.textContent = preventEmptyString(difference.value);
				if (difference.added) {
					span.classList.add(charClass);
				}
				fragment.appendChild(span);
			}
		} else if (line1 != undefined && line2 == undefined) {
			const span = document.createElement("span");
			// Necessary to give the line a height when it's empty.
			span.textContent = preventEmptyString(line1);
			span.classList.add(charClass);
			fragment.appendChild(span);
		} else {
			fragment.textContent = preventEmptyString(line1);
		}

		return fragment;
	}

	private scrollToFirstDifference(): void {
		if (this.fileDifferences?.differences.length === 0) {
			return;
		}

		const containerRect = this.contentEl
			.getElementsByClassName("file-diff__container")[0]
			.getBoundingClientRect();
		const elementRect = this.contentEl
			.getElementsByClassName("difference")[0]
			.getBoundingClientRect();
		this.contentEl.scrollTo({
			top: elementRect.top - containerRect.top - 100,
			behavior: "smooth",
		});
	}
}
