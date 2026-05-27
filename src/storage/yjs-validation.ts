import * as Y from 'yjs';

/**
 * Validate a Yjs update by applying it to a throwaway doc.
 * Catches truncated binary data (e.g. incomplete delete set)
 * that encodeStateVectorFromUpdate alone would miss.
 *
 * Returns null if valid, or the Error if invalid.
 */
export const validateUpdate = (update: Uint8Array): Error | null => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  } finally {
    doc.destroy();
  }
};
