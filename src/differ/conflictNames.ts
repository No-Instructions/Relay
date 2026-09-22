import type { ConflictSide, ConflictValue } from "../merge-hsm/conflictValue";

/**
 * The names the differ shows for the two sides of a conflict. They come from
 * what each side is and what it is compared with, never from the engine: the
 * record is this device's copy against the remote, the note as Obsidian had it
 * against a file that changed, and Relay's copy against the editor.
 */
export function conflictSideNames(conflict: ConflictValue): { ours: string; theirs: string } {
	const name = (side: ConflictSide, other: ConflictSide): string => {
		switch (side.source) {
			case "editor":
				return "Editor";
			case "file":
				return "Local file";
			case "remote":
				return "Remote";
			case "record":
				if (other.source === "editor") return "Relay's copy";
				if (other.source === "file") return "Note in Obsidian";
				return "Local";
		}
	};
	return {
		ours: name(conflict.ours, conflict.theirs),
		theirs: name(conflict.theirs, conflict.ours),
	};
}
