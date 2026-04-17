/**
 * Fixture Loading Helpers
 *
 * Loads JSONL recordings, JSON snapshots, and other fixtures from
 * co-located `fixtures/` directories within per-TP test directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { HSMLogEntry } from '../recording/types';
import type { DocContentSnapshot } from './integration';

/**
 * Resolve the fixtures directory for a given TP test directory.
 * Called from within a test file: `fixturesDir(__dirname)` returns
 * the `fixtures/` subdirectory adjacent to the test file.
 */
export function fixturesDir(testDir: string): string {
  return path.join(testDir, 'fixtures');
}

/**
 * Load a JSONL fixture file and return parsed entries.
 */
export function loadFixtureFile(filepath: string): HSMLogEntry[] {
  const content = fs.readFileSync(filepath, 'utf-8');
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as HSMLogEntry);
}

/**
 * Load all JSONL fixtures from a directory.
 */
export function loadAllFixtures(dirPath: string): Map<string, HSMLogEntry[]> {
  const result = new Map<string, HSMLogEntry[]>();
  if (!fs.existsSync(dirPath)) return result;

  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    result.set(file, loadFixtureFile(path.join(dirPath, file)));
  }
  return result;
}

/**
 * Load a JSON snapshot file (doc-content, inputs, sequence, etc.).
 */
export function loadSnapshot<T = any>(filepath: string): T {
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

/**
 * Load a doc-content snapshot from a JSON file.
 */
export function loadDocContentSnapshot(filepath: string): DocContentSnapshot {
  return loadSnapshot<DocContentSnapshot>(filepath);
}

/**
 * List all JSONL fixture filenames in a directory.
 */
export function listFixtureFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')).sort();
}

/**
 * Check if a fixtures directory exists and has files.
 */
export function hasFixtures(dirPath: string): boolean {
  return fs.existsSync(dirPath) && listFixtureFiles(dirPath).length > 0;
}
