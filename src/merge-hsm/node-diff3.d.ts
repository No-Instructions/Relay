/**
 * Type declarations for node-diff3.
 * The package is browser-compatible but uses modern exports that
 * TypeScript's "node" moduleResolution doesn't understand.
 */

declare module 'node-diff3' {
  export interface MergeRegion<T> {
    ok?: T[];
    conflict?: {
      a: T[];
      aIndex: number;
      b: T[];
      bIndex: number;
      o: T[];
      oIndex: number;
    };
  }

  export interface MergeResult {
    conflict: boolean;
    result: string[];
  }

  export interface IMergeOptions {
    excludeFalseConflicts?: boolean;
    stringSeparator?: string | RegExp;
  }

  export function diff3Merge<T>(
    a: string | T[],
    o: string | T[],
    b: string | T[],
    options?: IMergeOptions
  ): MergeRegion<T>[];

  export function merge<T>(
    a: string | T[],
    o: string | T[],
    b: string | T[],
    options?: IMergeOptions
  ): MergeResult;
}
