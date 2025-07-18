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

import { TFile } from "obsidian";
import { Difference } from "./difference";
import { deleteLines, insertLine, replaceLine } from "./stringUtils";
import { ActionLineButton } from "./actionLineButton";
import { ActionLineDivider } from "./actionLineDivider";
import { Document } from "src/Document";
import { DiskBuffer } from "src/DiskBuffer";
import { diffMatchPatch } from "src/y-diffMatchPatch";
import type { App } from "obsidian";

type VoidCallback = () => void;

export class ActionLine {
	constructor(
		private app: App,
		args: {
			difference: Difference;
			file1: TFile;
			file2: TFile;
			file1Content: string;
			file2Content: string;
			triggerRebuild: VoidCallback;
		},
	) {
		this.difference = args.difference;
		this.file1 = args.file1;
		this.file2 = args.file2;
		this.file1Content = args.file1Content;
		this.file2Content = args.file2Content;
		this.triggerRebuild = args.triggerRebuild;
	}

	private difference: Difference;

	private file1: TFile;

	private file2: TFile;

	private file1Content: string;

	private file2Content: string;

	private triggerRebuild: VoidCallback;

	async modify(file: TFile, newContent: string): Promise<void> {
		if (file instanceof Document) {
			diffMatchPatch(file.ydoc, newContent, file);
			return;
		} else if (file instanceof DiskBuffer) {
			file.contents = newContent;
			return;
		}
		await this.app.vault.modify(file, newContent);
	}

	build(container: HTMLDivElement): void {
		const actionLine = container.createDiv({
			cls: "flex flex-row gap-1 py-0-5",
		});

		const hasMinusLines = this.difference.file1Lines.length > 0;
		const hasPlusLines = this.difference.file2Lines.length > 0;

		if (hasPlusLines && hasMinusLines) {
			new ActionLineButton({
				text: "Accept Top (Editor)",
				onClick: (e) => this.acceptTopClick(e, this.difference),
			}).build(actionLine);
			ActionLineDivider.build(actionLine);
			new ActionLineButton({
				text: "Accept Bottom (Local Disk)",
				onClick: (e) => this.acceptBottomClick(e, this.difference),
			}).build(actionLine);
			ActionLineDivider.build(actionLine);
			new ActionLineButton({
				text: "Accept All",
				onClick: (e) => this.acceptAllClick(e, this.difference),
			}).build(actionLine);
			ActionLineDivider.build(actionLine);
			new ActionLineButton({
				text: "Accept None",
				onClick: (e) => this.acceptNoneClick(e, this.difference),
			}).build(actionLine);
		} else if (hasMinusLines) {
			new ActionLineButton({
				text: `Keep in Editor`,
				onClick: (e) => this.insertFile1Difference(e, this.difference),
			}).build(actionLine);
			ActionLineDivider.build(actionLine);
			new ActionLineButton({
				text: "Discard in Editor",
				onClick: (e) => this.discardFile1Difference(e, this.difference),
			}).build(actionLine);
		} else if (hasPlusLines) {
			new ActionLineButton({
				text: `Accept from Local Disk`,
				onClick: (e) => this.insertFile2Difference(e, this.difference),
			}).build(actionLine);
			ActionLineDivider.build(actionLine);
			new ActionLineButton({
				text: "Discard on Disk",
				onClick: (e) => this.discardFile2Difference(e, this.difference),
			}).build(actionLine);
		}
	}

	private async acceptTopClick(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const changedLines = difference.file1Lines.join("\n");
		const newContent = replaceLine({
			fullText: this.file2Content,
			newLine: changedLines,
			position: difference.file2Start,
			linesToReplace: difference.file2Lines.length,
		});
		await this.modify(this.file2, newContent);

		this.triggerRebuild();
	}

	private async acceptBottomClick(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const changedLines = difference.file2Lines.join("\n");
		const newContent = replaceLine({
			fullText: this.file1Content,
			newLine: changedLines,
			position: difference.file1Start,
			linesToReplace: difference.file1Lines.length,
		});
		await this.modify(this.file1, newContent);

		this.triggerRebuild();
	}

	private async acceptAllClick(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const changedLines = [
			...difference.file1Lines,
			...difference.file2Lines,
		].join("\n");

		const newFile1Content = replaceLine({
			fullText: this.file1Content,
			newLine: changedLines,
			position: difference.file1Start,
			linesToReplace: difference.file1Lines.length,
		});
		await this.modify(this.file1, newFile1Content);

		const newFile2Content = replaceLine({
			fullText: this.file2Content,
			newLine: changedLines,
			position: difference.file2Start,
			linesToReplace: difference.file2Lines.length,
		});
		await this.modify(this.file2, newFile2Content);

		this.triggerRebuild();
	}

	private async acceptNoneClick(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const newFile1Content = deleteLines({
			fullText: this.file1Content,
			position: difference.file1Start,
			count: difference.file1Lines.length,
		});
		await this.modify(this.file1, newFile1Content);

		const newFile2Content = deleteLines({
			fullText: this.file2Content,
			position: difference.file2Start,
			count: difference.file2Lines.length,
		});
		await this.modify(this.file2, newFile2Content);

		this.triggerRebuild();
	}

	private async insertFile1Difference(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const changedLines = difference.file1Lines.join("\n");
		const newContent = insertLine({
			fullText: this.file2Content,
			newLine: changedLines,
			position: difference.file2Start,
		});
		await this.modify(this.file2, newContent);

		this.triggerRebuild();
	}

	private async insertFile2Difference(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const changedLines = difference.file2Lines.join("\n");
		const newContent = insertLine({
			fullText: this.file1Content,
			newLine: changedLines,
			position: difference.file1Start,
		});
		await this.modify(this.file1, newContent);

		this.triggerRebuild();
	}

	async discardFile1Difference(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const newContent = deleteLines({
			fullText: this.file1Content,
			position: difference.file1Start,
			count: difference.file1Lines.length,
		});
		await this.modify(this.file1, newContent);

		this.triggerRebuild();
	}

	async discardFile2Difference(
		event: MouseEvent,
		difference: Difference,
	): Promise<void> {
		event.preventDefault();

		const newContent = deleteLines({
			fullText: this.file2Content,
			position: difference.file2Start,
			count: difference.file2Lines.length,
		});
		await this.modify(this.file2, newContent);

		this.triggerRebuild();
	}
}
