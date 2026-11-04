import { around } from "monkey-around";

export interface HistoryBackTarget {
	onHistoryBack(): void;
}

export function wrapHistoryBack(
	target: HistoryBackTarget,
	handle: (next: () => void) => void,
): () => void {
	return around<{ onHistoryBack: () => void }>(target, {
		onHistoryBack: (next) => () => handle(() => next.call(target)),
	});
}
