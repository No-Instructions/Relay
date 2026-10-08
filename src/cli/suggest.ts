import { prepareFuzzySearch } from "obsidian";

/** Rank alternatives with the host's matcher; never resolve a target. */
export function suggest<T>(query: string, items: readonly T[], labels: (item: T) => readonly string[]): T[] {
	if (!query.trim()) return [];
	const search = prepareFuzzySearch(query.trim());
	return items.map((item) => ({
		item,
		score: Math.max(...labels(item).map((label) => search(label)?.score ?? -Infinity)),
	})).filter(({ score }) => score > -Infinity)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map(({ item }) => item);
}
