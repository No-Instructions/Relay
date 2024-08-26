/** Method to insert a line in a string */
export function insertLine(args: {
	fullText: string;
	newLine: string;
	position: number;
}): string {
	const lines = args.fullText.split("\n");
	lines.splice(args.position, 0, args.newLine);
	return lines.join("\n");
}

/** Method to replace a line in a string */
export function replaceLine(args: {
	fullText: string;
	newLine: string;
	position: number;
	linesToReplace: number;
}): string {
	const lines = args.fullText.split("\n");
	if (args.newLine === "") {
		lines.splice(args.position, args.linesToReplace);
	} else {
		lines.splice(args.position, args.linesToReplace, args.newLine);
	}
	return lines.join("\n");
}

/** Method to delete a line in a string */
export function deleteLines(args: {
	fullText: string;
	position: number;
	count: number;
}): string {
	const lines = args.fullText.split("\n");
	lines.splice(args.position, args.count);
	return lines.join("\n");
}

/** Returns an invisible character when the text is empty. */
export function preventEmptyString(text: string): string {
	return text !== "" ? text : "‎";
}
