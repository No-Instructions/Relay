import matter from "gray-matter";

interface Frontmatter {
	[key: string]: unknown;
}

export function updateFrontMatter(
	markdownString: string,
	newEntry: Frontmatter,
): string {
	const parsed = matter(markdownString);

	for (const key in newEntry) {
		parsed.data[key] = newEntry[key];
	}

	const result = matter.stringify(parsed.content, parsed.data);
	return result.slice(0, -1); // remove trailing \n
}

export function hasKey(markdownString: string, keyMatch: string) {
	const parsed = matter(markdownString);
	return parsed.data.hasOwnProperty(keyMatch);
}

export function removeKey(markdownString: string, keyMatch: string) {
	const parsed = matter(markdownString);

	for (const key in parsed.data) {
		if (key === keyMatch) {
			parsed.data.remove(key);
		}
	}

	const result = matter.stringify(parsed.content, parsed.data);
	return result.slice(0, -1); // remove trailing \n
}
