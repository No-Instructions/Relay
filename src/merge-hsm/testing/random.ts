/**
 * Global seeded PRNG for deterministic test timing.
 *
 * Usage:
 *   TEST_SEED=12345 npm test
 *
 * Same seed = same random sequence = reproducible test runs.
 */

/**
 * Mulberry32 PRNG - fast, simple, seedable
 */
class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

// Global fountain - seeded once at module load
const TEST_SEED = parseInt(process.env.TEST_SEED ?? '12345', 10);
const DELAYS_ENABLED = process.env.TEST_ASYNC_DELAYS === '1';
let fountain = new SeededRandom(TEST_SEED);

if (DELAYS_ENABLED) {
  console.log(`[test] Random delays ENABLED, seed: ${TEST_SEED}`);
}

/** Check if async delays are enabled */
export function delaysEnabled(): boolean {
  return DELAYS_ENABLED;
}

/** Get next random int from the fountain */
export function nextInt(min: number, max: number): number {
  return fountain.int(min, max);
}

/** Get next random delay in ms, then wait (only if TEST_ASYNC_DELAYS=1) */
export function nextDelay(minMs: number, maxMs: number): Promise<void> {
  if (!DELAYS_ENABLED) return Promise.resolve();
  const ms = fountain.int(minMs, maxMs);
  if (ms === 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Reset fountain (for test isolation if needed) */
export function resetFountain(seed = TEST_SEED): void {
  fountain = new SeededRandom(seed);
}
