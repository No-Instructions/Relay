// Code in this file has been adapted from y-codemirror.next
// License
// [The MIT License](./LICENSE) © Kevin Jahns

import { EditorSelection, SelectionRange } from "@codemirror/state";
import { RelativePosition, YText } from "yjs/dist/src/internals";
import { YRange } from "./YRange";

import * as Y from "yjs"; // eslint-disable-line

export class PositionTranformer {
	ytext: YText;

	constructor(ytext: YText) {
		this.ytext = ytext;
	}

	/**
	 * Helper function to transform an absolute index position to a Yjs-based relative position
	 * (https://docs.yjs.dev/api/relative-positions).
	 *
	 * A relative position can be transformed back to an absolute position even after the document has changed. The position is
	 * automatically adapted. This does not require any position transformations. Relative positions are computed based on
	 * the internal Yjs document model. Peers that share content through Yjs are guaranteed that their positions will always
	 * synced up when using relatve positions.
	 *
	 * ```js
	 * import { ySyncFacet } from 'y-codemirror'
	 *
	 * ..
	 * const ysync = view.state.facet(ySyncFacet)
	 * // transform an absolute index position to a ypos
	 * const ypos = ysync.getYPos(3)
	 * // transform the ypos back to an absolute position
	 * ysync.fromYPos(ypos) // => 3
	 * ```
	 *
	 * It cannot be guaranteed that absolute index positions can be synced up between peers.
	 * This might lead to undesired behavior when implementing features that require that all peers see the
	 * same marked range (e.g. a comment plugin).
	 *
	 */
	toYPos(pos: number, assoc = 0) {
		return Y.createRelativePositionFromTypeIndex(this.ytext, pos, assoc);
	}

	fromYPos(rpos: RelativePosition | object) {
		if (!this.ytext.doc) {
			throw new Error("YText is missing a document");
		}
		const pos = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(rpos),
			this.ytext.doc,
		);
		if (pos == null || pos.type !== this.ytext) {
			throw new Error(
				"[y-codemirror] The position you want to retrieve was created by a different document",
			);
		}
		return {
			pos: pos.index,
			assoc: pos.assoc,
		};
	}

	toYRange(range: SelectionRange): YRange {
		const assoc = range.assoc;
		const yanchor = this.toYPos(range.anchor, assoc);
		const yhead = this.toYPos(range.head, assoc);
		return new YRange(yanchor, yhead);
	}

	fromYRange(yrange: YRange) {
		const anchor = this.fromYPos(yrange.yanchor);
		const head = this.fromYPos(yrange.yhead);
		if (anchor.pos === head.pos) {
			return EditorSelection.cursor(head.pos, head.assoc);
		}
		return EditorSelection.range(anchor.pos, head.pos);
	}
}
