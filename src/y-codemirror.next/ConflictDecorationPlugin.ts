/**
 * ConflictDecorationPlugin - Inline conflict decorations for CodeMirror 6
 *
 * Renders inline conflict resolution UI directly in the editor:
 * - Conflict header with Accept Local / Accept Remote / Accept Both buttons
 * - Local content highlighted with green background
 * - Remote content shown as widget decoration
 * - Integrates with MergeHSM for conflict state management
 */

import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
} from '@codemirror/view';
import type { ViewUpdate, DecorationSet } from '@codemirror/view';
import type { Range } from '@codemirror/state';
import type { MergeHSM } from '../merge-hsm/MergeHSM';
import type { PositionedConflict } from '../merge-hsm/types';

// =============================================================================
// Widget Classes
// =============================================================================

/**
 * Widget for conflict action buttons at the top of a conflict region.
 */
class ConflictHeaderWidget extends WidgetType {
  constructor(
    private index: number,
    private onResolve: (index: number, resolution: 'local' | 'remote' | 'both') => void
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-conflict-header';

    // Label
    const label = document.createElement('span');
    label.className = 'cm-conflict-label';
    label.textContent = `Conflict #${this.index + 1}`;
    container.appendChild(label);

    // Button container
    const buttons = document.createElement('div');
    buttons.className = 'cm-conflict-buttons';

    const localBtn = document.createElement('button');
    localBtn.textContent = 'Accept Local';
    localBtn.className = 'cm-conflict-btn cm-conflict-btn-local';
    localBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onResolve(this.index, 'local');
    };

    const remoteBtn = document.createElement('button');
    remoteBtn.textContent = 'Accept Remote';
    remoteBtn.className = 'cm-conflict-btn cm-conflict-btn-remote';
    remoteBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onResolve(this.index, 'remote');
    };

    const bothBtn = document.createElement('button');
    bothBtn.textContent = 'Accept Both';
    bothBtn.className = 'cm-conflict-btn cm-conflict-btn-both';
    bothBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onResolve(this.index, 'both');
    };

    buttons.appendChild(localBtn);
    buttons.appendChild(remoteBtn);
    buttons.appendChild(bothBtn);
    container.appendChild(buttons);

    return container;
  }

  eq(other: ConflictHeaderWidget): boolean {
    return this.index === other.index;
  }

  ignoreEvent(): boolean {
    return false; // Allow click events
  }
}

/**
 * Widget to display the remote/disk version of the conflict.
 */
class ConflictRemoteContentWidget extends WidgetType {
  constructor(
    private remoteContent: string,
    private index: number
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-conflict-remote-container';

    // Separator
    const separator = document.createElement('div');
    separator.className = 'cm-conflict-separator';
    separator.textContent = '═══════════ Remote/Disk ═══════════';
    container.appendChild(separator);

    // Remote content
    const content = document.createElement('div');
    content.className = 'cm-conflict-remote-content';
    // Preserve whitespace and newlines
    content.style.whiteSpace = 'pre-wrap';
    content.textContent = this.remoteContent || '(empty)';
    container.appendChild(content);

    // End marker
    const endMarker = document.createElement('div');
    endMarker.className = 'cm-conflict-end-marker';
    endMarker.textContent = '═══════════════════════════════════';
    container.appendChild(endMarker);

    return container;
  }

  eq(other: ConflictRemoteContentWidget): boolean {
    return this.index === other.index && this.remoteContent === other.remoteContent;
  }

  ignoreEvent(): boolean {
    return true; // Don't capture events
  }
}

// =============================================================================
// Plugin Value Class
// =============================================================================

/**
 * Plugin value that manages conflict decorations.
 */
class ConflictDecorationPluginValue {
  decorations: DecorationSet = Decoration.none;
  private hsm: MergeHSM | null = null;
  private unsubscribe: (() => void) | null = null;
  private conflicts: PositionedConflict[] = [];
  private resolvedIndices: Set<number> = new Set();

  constructor(private view: EditorView) {}

  /**
   * Connect this plugin to an HSM instance.
   */
  setHSM(hsm: MergeHSM): void {
    // Clean up previous subscription
    if (this.unsubscribe) {
      this.unsubscribe();
    }

    this.hsm = hsm;
    this.unsubscribe = hsm.effects.subscribe((effect) => {
      if (effect.type === 'SHOW_CONFLICT_DECORATIONS') {
        this.conflicts = effect.positions;
        this.resolvedIndices.clear();
        this.updateDecorations();
      } else if (effect.type === 'HIDE_CONFLICT_DECORATION') {
        this.resolvedIndices.add(effect.index);
        this.updateDecorations();
      }
    });
  }

  /**
   * Clear all conflict decorations.
   */
  clearConflicts(): void {
    this.conflicts = [];
    this.resolvedIndices.clear();
    this.decorations = Decoration.none;
  }

  /**
   * Update decorations based on current conflict state.
   */
  private updateDecorations(): void {
    const decorationRanges: Range<Decoration>[] = [];
    const docLength = this.view.state.doc.length;

    for (const conflict of this.conflicts) {
      if (this.resolvedIndices.has(conflict.index)) continue;

      // Ensure positions are within document bounds
      const localStart = Math.min(Math.max(0, conflict.localStart), docLength);
      const localEnd = Math.min(Math.max(localStart, conflict.localEnd), docLength);

      // Header widget with buttons (block decoration before conflict)
      decorationRanges.push(
        Decoration.widget({
          widget: new ConflictHeaderWidget(conflict.index, this.handleResolve.bind(this)),
          block: true,
          side: -1,
        }).range(localStart)
      );

      // Local content background highlight (green tint)
      if (localEnd > localStart) {
        decorationRanges.push(
          Decoration.mark({
            class: 'cm-conflict-local-content',
          }).range(localStart, localEnd)
        );
      }

      // Remote content widget (shown after local content)
      decorationRanges.push(
        Decoration.widget({
          widget: new ConflictRemoteContentWidget(conflict.theirsContent, conflict.index),
          block: true,
          side: 1,
        }).range(localEnd)
      );
    }

    // Sort by position for proper decoration ordering
    decorationRanges.sort((a, b) => a.from - b.from);

    this.decorations = Decoration.set(decorationRanges, true);
  }

  /**
   * Handle resolution button click.
   */
  private handleResolve(index: number, resolution: 'local' | 'remote' | 'both'): void {
    if (this.hsm) {
      this.hsm.send({ type: 'RESOLVE_HUNK', index, resolution });
    }
  }

  /**
   * Update decorations when document changes.
   */
  update(update: ViewUpdate): void {
    // Remap decoration positions if document changed
    if (update.docChanged && this.decorations !== Decoration.none) {
      this.decorations = this.decorations.map(update.changes);
    }
  }

  /**
   * Clean up subscriptions.
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.hsm = null;
  }
}

// =============================================================================
// Plugin Export
// =============================================================================

/**
 * ViewPlugin for conflict decorations.
 */
export const conflictDecorationPlugin = ViewPlugin.fromClass(
  ConflictDecorationPluginValue,
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * Get the plugin instance from an EditorView.
 */
export function getConflictDecorationPlugin(view: EditorView): ConflictDecorationPluginValue | null {
  return view.plugin(conflictDecorationPlugin);
}

// =============================================================================
// Theme Export
// =============================================================================

/**
 * Base theme for conflict decorations.
 */
export const conflictDecorationTheme = EditorView.baseTheme({
  '.cm-conflict-header': {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 12px',
    backgroundColor: 'var(--background-modifier-border)',
    borderTop: '2px solid var(--text-accent)',
    borderLeft: '3px solid var(--text-accent)',
    fontSize: '12px',
    fontFamily: 'var(--font-interface)',
  },
  '.cm-conflict-label': {
    fontWeight: '600',
    color: 'var(--text-accent)',
  },
  '.cm-conflict-buttons': {
    display: 'flex',
    gap: '6px',
  },
  '.cm-conflict-btn': {
    padding: '3px 10px',
    borderRadius: '4px',
    border: '1px solid var(--background-modifier-border)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: '500',
    transition: 'background-color 0.15s ease',
  },
  '.cm-conflict-btn:hover': {
    filter: 'brightness(0.95)',
  },
  '.cm-conflict-btn-local': {
    backgroundColor: 'rgba(40, 167, 69, 0.2)',
    borderColor: 'rgba(40, 167, 69, 0.5)',
    color: 'var(--text-normal)',
  },
  '.cm-conflict-btn-local:hover': {
    backgroundColor: 'rgba(40, 167, 69, 0.35)',
  },
  '.cm-conflict-btn-remote': {
    backgroundColor: 'rgba(0, 123, 255, 0.2)',
    borderColor: 'rgba(0, 123, 255, 0.5)',
    color: 'var(--text-normal)',
  },
  '.cm-conflict-btn-remote:hover': {
    backgroundColor: 'rgba(0, 123, 255, 0.35)',
  },
  '.cm-conflict-btn-both': {
    backgroundColor: 'rgba(108, 117, 125, 0.2)',
    borderColor: 'rgba(108, 117, 125, 0.5)',
    color: 'var(--text-normal)',
  },
  '.cm-conflict-btn-both:hover': {
    backgroundColor: 'rgba(108, 117, 125, 0.35)',
  },
  '.cm-conflict-local-content': {
    backgroundColor: 'rgba(40, 167, 69, 0.12)',
    borderLeft: '3px solid rgba(40, 167, 69, 0.5)',
  },
  '.cm-conflict-remote-container': {
    borderLeft: '3px solid rgba(0, 123, 255, 0.5)',
    marginLeft: '0',
  },
  '.cm-conflict-separator': {
    textAlign: 'center',
    color: 'var(--text-muted)',
    padding: '4px 0',
    backgroundColor: 'var(--background-modifier-border)',
    fontSize: '10px',
    fontFamily: 'monospace',
  },
  '.cm-conflict-remote-content': {
    backgroundColor: 'rgba(0, 123, 255, 0.12)',
    padding: '4px 8px',
    fontFamily: 'var(--font-monospace)',
    fontSize: 'var(--font-text-size)',
  },
  '.cm-conflict-end-marker': {
    textAlign: 'center',
    color: 'var(--text-muted)',
    padding: '4px 0',
    backgroundColor: 'var(--background-modifier-border)',
    fontSize: '10px',
    fontFamily: 'monospace',
    borderBottom: '2px solid var(--text-accent)',
  },
});
