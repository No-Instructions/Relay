import * as fs from 'fs';
import * as path from 'path';
import type { HSMLogEntry } from 'src/merge-hsm/recording/types';

/**
 * Load log entries from a JSONL file (one JSON per line).
 */
export function loadLogFixture(filepath: string): HSMLogEntry[] {
  const content = fs.readFileSync(filepath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as HSMLogEntry);
}

/**
 * Load all log fixtures from a directory (all .jsonl files).
 */
export function loadLogFixtures(dirPath: string): HSMLogEntry[][] {
  const files = fs.readdirSync(dirPath).filter((file) => file.endsWith('.jsonl'));
  return files.map((file) => loadLogFixture(path.join(dirPath, file)));
}
