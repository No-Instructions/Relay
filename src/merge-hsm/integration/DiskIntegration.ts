/**
 * DiskIntegration - Filesystem Integration for MergeHSM
 *
 * Bridges the MergeHSM with the filesystem (Obsidian vault):
 * - Subscribes to HSM WRITE_DISK effects
 * - Forwards file modification events to HSM
 * - Handles save completion events
 */

import type { MergeHSM } from '../MergeHSM';

// =============================================================================
// Vault Interface
// =============================================================================

/**
 * Minimal interface for an Obsidian-like vault.
 */
export interface Vault {
  /**
   * Read file contents as string.
   */
  read(path: string): Promise<string>;

  /**
   * Write/modify file contents.
   */
  modify(path: string, contents: string): Promise<void>;

  /**
   * Get file modification time.
   */
  getMtime(path: string): Promise<number>;

  /**
   * Subscribe to file modification events.
   * Returns an unsubscribe function.
   */
  onModify(callback: (path: string, mtime: number) => void): () => void;
}

/**
 * Hash function type.
 */
export type HashFn = (contents: string) => Promise<string>;

// =============================================================================
// DiskIntegration Class
// =============================================================================

export class DiskIntegration {
  private hsm: MergeHSM;
  private vault: Vault;
  private hashFn: HashFn;
  private unsubscribeHSM: (() => void) | null = null;
  private unsubscribeVault: (() => void) | null = null;
  private lastKnownMtime: number = 0;

  /** Get current path from HSM (handles renames) */
  private get path(): string {
    return this.hsm.path;
  }

  constructor(
    hsm: MergeHSM,
    vault: Vault,
    hashFn: HashFn
  ) {
    this.hsm = hsm;
    this.vault = vault;
    this.hashFn = hashFn;

    // Subscribe to HSM effects for WRITE_DISK (filter by guid for rename safety)
    this.unsubscribeHSM = hsm.effects.subscribe(async (effect) => {
      if (effect.type === 'WRITE_DISK' && effect.guid === hsm.guid) {
        // Fail-closed interlock: never write to disk when Obsidian has the file open
        if (hsm.isObsidianFileOpen) {
          console.error(
            '[DiskIntegration] FATAL: WRITE_DISK blocked - Obsidian has file open:',
            hsm.path,
            'state:', hsm.statePath
          );
          return;
        }
        await this.writeToDisk(effect.contents);
      }
    });

    // Subscribe to vault file modification events
    this.unsubscribeVault = vault.onModify(async (modifiedPath, mtime) => {
      if (modifiedPath === this.path && mtime !== this.lastKnownMtime) {
        await this.handleDiskChange();
      }
    });
  }

  /**
   * Write contents to disk.
   */
  private async writeToDisk(contents: string): Promise<void> {
    await this.vault.modify(this.path, contents);
    this.lastKnownMtime = await this.vault.getMtime(this.path);
  }

  /**
   * Handle external disk changes.
   */
  private async handleDiskChange(): Promise<void> {
    const contents = await this.vault.read(this.path);
    const mtime = await this.vault.getMtime(this.path);
    const hash = await this.hashFn(contents);

    this.lastKnownMtime = mtime;

    this.hsm.send({
      type: 'DISK_CHANGED',
      contents,
      mtime,
      hash,
    });
  }

  /**
   * Notify HSM that a save has completed.
   * Call this after Obsidian's file save completes.
   */
  onSaveComplete(mtime: number, hash: string): void {
    this.lastKnownMtime = mtime;
    this.hsm.send({
      type: 'SAVE_COMPLETE',
      mtime,
      hash,
    });
  }

  /**
   * Poll for disk changes.
   * Useful when filesystem events are unreliable.
   */
  async poll(): Promise<void> {
    const mtime = await this.vault.getMtime(this.path);
    if (mtime !== this.lastKnownMtime) {
      await this.handleDiskChange();
    }
  }

  /**
   * Initialize with current disk state.
   */
  async initialize(): Promise<void> {
    await this.handleDiskChange();
  }

  /**
   * Destroy the integration and cleanup.
   */
  destroy(): void {
    if (this.unsubscribeHSM) {
      this.unsubscribeHSM();
      this.unsubscribeHSM = null;
    }

    if (this.unsubscribeVault) {
      this.unsubscribeVault();
      this.unsubscribeVault = null;
    }
  }
}
