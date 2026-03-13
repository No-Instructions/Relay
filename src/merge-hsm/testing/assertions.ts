/**
 * Test Assertions
 *
 * Custom assertion helpers for MergeHSM tests.
 * These work with Jest's expect API.
 */

import type { MergeEffect, StatePath } from '../types';
import type { TestHSM } from './createTestHSM';

// =============================================================================
// Effect Assertions
// =============================================================================

/**
 * Assert that the effects array contains an effect matching the expected shape.
 * Uses partial matching - only specified fields are checked.
 */
export function expectEffect(
  effects: MergeEffect[],
  expected: Partial<MergeEffect> & { type: MergeEffect['type'] }
): void {
  const match = effects.find(e => effectMatches(e, expected));

  if (!match) {
    const effectTypes = effects.map(e => e.type).join(', ');
    throw new Error(
      `Expected effect ${JSON.stringify(expected)}\n` +
      `Effects received: [${effectTypes}]\n` +
      `Full effects: ${JSON.stringify(effects, null, 2)}`
    );
  }
}

/**
 * Assert that no effect of the given type was emitted.
 */
export function expectNoEffect(
  effects: MergeEffect[],
  type: MergeEffect['type']
): void {
  const match = effects.find(e => e.type === type);

  if (match) {
    throw new Error(
      `Expected no ${type} effect, but found: ${JSON.stringify(match, null, 2)}`
    );
  }
}

/**
 * Assert the exact number of effects of a given type.
 */
export function expectEffectCount(
  effects: MergeEffect[],
  type: MergeEffect['type'],
  count: number
): void {
  const matches = effects.filter(e => e.type === type);

  if (matches.length !== count) {
    throw new Error(
      `Expected ${count} ${type} effect(s), but found ${matches.length}:\n` +
      JSON.stringify(matches, null, 2)
    );
  }
}

/**
 * Get all effects of a specific type.
 */
export function getEffects<T extends MergeEffect['type']>(
  effects: MergeEffect[],
  type: T
): Extract<MergeEffect, { type: T }>[] {
  return effects.filter(e => e.type === type) as Extract<MergeEffect, { type: T }>[];
}

// =============================================================================
// State Assertions
// =============================================================================

/**
 * Assert that the HSM is in a specific state.
 */
export function expectState(hsm: TestHSM, statePath: StatePath): void {
  if (!hsm.matches(statePath)) {
    throw new Error(
      `Expected state "${statePath}", but got "${hsm.statePath}"`
    );
  }
}

// =============================================================================
// Content Assertions
// =============================================================================

/**
 * Assert the localDoc text content.
 */
export function expectLocalDocText(hsm: TestHSM, expected: string): void {
  const actual = hsm.getLocalDocText();

  if (actual === null) {
    throw new Error(
      `Expected localDoc text "${expected}", but localDoc is null (not in active mode?)`
    );
  }

  if (actual !== expected) {
    throw new Error(
      `Expected localDoc text:\n"${expected}"\n\nGot:\n"${actual}"`
    );
  }
}

/**
 * Assert the remoteDoc text content.
 */
export function expectRemoteDocText(hsm: TestHSM, expected: string): void {
  const actual = hsm.getRemoteDocText();

  if (actual === null) {
    throw new Error(
      `Expected remoteDoc text "${expected}", but remoteDoc is null (not in active mode?)`
    );
  }

  if (actual !== expected) {
    throw new Error(
      `Expected remoteDoc text:\n"${expected}"\n\nGot:\n"${actual}"`
    );
  }
}

// =============================================================================
// Helpers
// =============================================================================

function effectMatches(actual: MergeEffect, expected: Partial<MergeEffect>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = (actual as unknown as Record<string, unknown>)[key];

    if (value instanceof Uint8Array && actualValue instanceof Uint8Array) {
      if (!uint8ArrayEquals(value, actualValue)) {
        return false;
      }
    } else if (Array.isArray(value) && Array.isArray(actualValue)) {
      if (!arraysMatch(value, actualValue)) {
        return false;
      }
    } else if (typeof value === 'object' && value !== null) {
      if (!objectMatches(actualValue as Record<string, unknown>, value as Record<string, unknown>)) {
        return false;
      }
    } else if (actualValue !== value) {
      return false;
    }
  }
  return true;
}

function objectMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      return false;
    }
  }
  return true;
}

function arraysMatch(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    if (typeof item === 'object' && item !== null && typeof b[i] === 'object' && b[i] !== null) {
      return objectMatches(b[i] as Record<string, unknown>, item as Record<string, unknown>);
    }
    return item === b[i];
  });
}

function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
