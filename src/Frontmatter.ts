import matter from "gray-matter";

interface Frontmatter {
	[key: string]: unknown;
}

export function updateFrontMatter(
	markdownString: string,
	newEntry: Frontmatter,
): string {
	const parsed = matter(markdownString);
	const data = parsed.data as Frontmatter;

	for (const key in newEntry) {
		data[key] = newEntry[key];
	}

	const result = matter.stringify(parsed.content, data);
	return result.slice(0, -1); // remove trailing \n
}

export function hasKey(markdownString: string, keyMatch: string) {
	const parsed = matter(markdownString);
	const data = parsed.data as Frontmatter;
	return Object.prototype.hasOwnProperty.call(data, keyMatch);
}

export function removeKey(markdownString: string, keyMatch: string) {
	const parsed = matter(markdownString);
	const data = parsed.data as Frontmatter;

	delete data[keyMatch];

	const result = matter.stringify(parsed.content, data);
	return result.slice(0, -1); // remove trailing \n
}
