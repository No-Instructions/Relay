import { TFile, Vault } from "obsidian";

export class DiskBuffer implements TFile {
	path: string;
	name: string;
	extension: string;
	basename: string;
	parent: null = null;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};

	constructor(
		public vault: Vault,
		path: string,
		public contents: string,
	) {
		this.path = path;
		this.name = path.split("/").pop() || "";
		this.extension = this.name.includes(".")
			? this.name.split(".").pop() || ""
			: "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.stat = {
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
	}

	delete(): Promise<void> {
		return Promise.resolve();
	}

	rename(newPath: string): Promise<void> {
		this.path = newPath;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.includes(".")
			? this.name.split(".").pop() || ""
			: "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		return Promise.resolve();
	}

	getBasePath(): string {
		return this.path.substring(0, this.path.lastIndexOf("/"));
	}
}
