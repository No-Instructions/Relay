import { areObjectsEqual } from "./areObjectsEqual";
import type { CanvasData } from "./CanvasView";

interface CanvasItem {
	id: string;
}

export function areCanvasDataEqual(
	left: CanvasData | null | undefined,
	right: CanvasData | null | undefined,
): boolean {
	if (!left || !right) return false;
	return (
		areCanvasItemsEqual(left.nodes ?? [], right.nodes ?? []) &&
		areCanvasItemsEqual(left.edges ?? [], right.edges ?? [])
	);
}

function areCanvasItemsEqual<T extends CanvasItem>(
	left: readonly T[],
	right: readonly T[],
): boolean {
	if (left.length !== right.length) return false;

	const rightById = new Map(right.map((item) => [item.id, item]));
	for (const leftItem of left) {
		const rightItem = rightById.get(leftItem.id);
		if (!rightItem || !areObjectsEqual(leftItem, rightItem)) {
			return false;
		}
	}
	return true;
}
