/**
 * Serialization interfaces for OpCapture persistence.
 */

export interface SerializedCapturedOp {
	insertions: Uint8Array; // DSEncoderV1-encoded DeleteSet
	deletions: Uint8Array; // DSEncoderV1-encoded DeleteSet
	origin: string | null; // stringified origin for persistence
	timestamp: number; // ms since epoch
}

export interface SerializedCaptureState {
	entries: SerializedCapturedOp[];
}
