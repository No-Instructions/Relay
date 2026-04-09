/**
 * HSM Debugger View
 *
 * An Obsidian sidebar panel that displays MergeHSM state for debugging.
 * Shows current state path, recent events, effects, and divergences.
 *
 * Enabled via feature flag: enableMergeHSMDebugger
 */

import {
  ItemView,
  WorkspaceLeaf,
  type Workspace,
  setIcon,
} from 'obsidian';
import type { MergeState, MergeEvent, MergeEffect, StatePath } from '../types';
import type { InvariantViolation } from '../invariants';
import { curryLog } from '../../debug';

export const HSM_DEBUGGER_VIEW_TYPE = 'relay-hsm-debugger';

// =============================================================================
// Types
// =============================================================================

interface DebuggerData {
  /** Currently selected document */
  selectedGuid: string | null;

  /** Current state for selected document */
  currentState: MergeState | null;

  /** Recent events (most recent first) */
  recentEvents: Array<{
    timestamp: number;
    event: MergeEvent;
    stateBefore: StatePath;
    stateAfter: StatePath;
  }>;

  /** Recent effects (most recent first) */
  recentEffects: Array<{
    timestamp: number;
    effect: MergeEffect;
  }>;

  /** Recent invariant violations */
  recentViolations: InvariantViolation[];

  /** Available documents */
  availableDocuments: Array<{ guid: string; path: string }>;
}

interface DebuggerCallbacks {
  /** Get available documents */
  getDocuments: () => Array<{ guid: string; path: string }>;

  /** Get state for a document */
  getState: (guid: string) => MergeState | null;

  /** Subscribe to state changes */
  onStateChange: (
    callback: (guid: string, state: MergeState) => void
  ) => () => void;

  /** Subscribe to events */
  onEvent: (
    callback: (guid: string, event: MergeEvent, before: StatePath, after: StatePath) => void
  ) => () => void;

  /** Subscribe to effects */
  onEffect: (
    callback: (guid: string, effect: MergeEffect) => void
  ) => () => void;

  /** Subscribe to violations */
  onViolation: (
    callback: (violation: InvariantViolation) => void
  ) => () => void;
}

// =============================================================================
// View Implementation
// =============================================================================

export class HSMDebuggerView extends ItemView {
  private data: DebuggerData = {
    selectedGuid: null,
    currentState: null,
    recentEvents: [],
    recentEffects: [],
    recentViolations: [],
    availableDocuments: [],
  };

  private callbacks: DebuggerCallbacks | null = null;
  private unsubscribes: Array<() => void> = [];
  private log = curryLog('[HSMDebugger]', 'log');

  private readonly maxEvents = 50;
  private readonly maxEffects = 50;
  private readonly maxViolations = 20;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return HSM_DEBUGGER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'HSM Debugger';
  }

  getIcon(): string {
    return 'bug';
  }

  /**
   * Set up the debugger callbacks.
   * Called by the plugin after view is created.
   */
  setCallbacks(callbacks: DebuggerCallbacks): void {
    this.callbacks = callbacks;
    this.setupSubscriptions();
    this.refreshDocuments();
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('hsm-debugger-container');

    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribes.forEach((unsub) => unsub());
    this.unsubscribes = [];
  }

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  private setupSubscriptions(): void {
    if (!this.callbacks) return;

    // State changes
    this.unsubscribes.push(
      this.callbacks.onStateChange((guid, state) => {
        if (guid === this.data.selectedGuid) {
          this.data.currentState = state;
          this.render();
        }
      })
    );

    // Events
    this.unsubscribes.push(
      this.callbacks.onEvent((guid, event, before, after) => {
        if (guid === this.data.selectedGuid) {
          this.data.recentEvents.unshift({
            timestamp: Date.now(),
            event,
            stateBefore: before,
            stateAfter: after,
          });
          if (this.data.recentEvents.length > this.maxEvents) {
            this.data.recentEvents.pop();
          }
          this.render();
        }
      })
    );

    // Effects
    this.unsubscribes.push(
      this.callbacks.onEffect((guid, effect) => {
        if (guid === this.data.selectedGuid) {
          this.data.recentEffects.unshift({
            timestamp: Date.now(),
            effect,
          });
          if (this.data.recentEffects.length > this.maxEffects) {
            this.data.recentEffects.pop();
          }
          this.render();
        }
      })
    );

    // Violations
    this.unsubscribes.push(
      this.callbacks.onViolation((violation) => {
        this.data.recentViolations.unshift(violation);
        if (this.data.recentViolations.length > this.maxViolations) {
          this.data.recentViolations.pop();
        }
        this.render();
      })
    );
  }

  private refreshDocuments(): void {
    if (!this.callbacks) return;
    this.data.availableDocuments = this.callbacks.getDocuments();
    this.render();
  }

  // ===========================================================================
  // Selection
  // ===========================================================================

  selectDocument(guid: string): void {
    this.data.selectedGuid = guid;
    this.data.currentState = this.callbacks?.getState(guid) ?? null;
    this.data.recentEvents = [];
    this.data.recentEffects = [];
    this.render();
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================

  private render(): void {
    const container = this.containerEl.children[1];
    container.empty();

    // Header
    this.renderHeader(container);

    // Document selector
    this.renderDocumentSelector(container);

    if (this.data.selectedGuid && this.data.currentState) {
      // State info
      this.renderStateInfo(container);

      // Tabs for events/effects/violations
      this.renderTabs(container);
    } else {
      container.createEl('p', {
        text: 'Select a document to view HSM state',
        cls: 'hsm-debugger-placeholder',
      });
    }
  }

  private renderHeader(container: Element): void {
    const header = container.createEl('div', { cls: 'hsm-debugger-header' });
    header.createEl('h3', { text: 'MergeHSM Debugger' });

    const refreshBtn = header.createEl('button', { cls: 'hsm-debugger-refresh' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refreshDocuments());
  }

  private renderDocumentSelector(container: Element): void {
    const selector = container.createEl('div', { cls: 'hsm-debugger-selector' });

    const select = selector.createEl('select', { cls: 'hsm-debugger-select' });

    select.createEl('option', { text: '-- Select Document --', value: '' });

    for (const doc of this.data.availableDocuments) {
      const option = select.createEl('option', {
        text: doc.path,
        value: doc.guid,
      });
      if (doc.guid === this.data.selectedGuid) {
        option.selected = true;
      }
    }

    select.addEventListener('change', () => {
      if (select.value) {
        this.selectDocument(select.value);
      }
    });
  }

  private renderStateInfo(container: Element): void {
    const state = this.data.currentState!;
    const info = container.createEl('div', { cls: 'hsm-debugger-state-info' });

    // State path with colored badge
    const stateBadge = info.createEl('div', { cls: 'hsm-debugger-state-badge' });
    const stateClass = this.getStateClass(state.statePath);
    stateBadge.addClass(stateClass);
    stateBadge.createEl('span', { text: state.statePath, cls: 'hsm-state-path' });

    // Key info
    const details = info.createEl('div', { cls: 'hsm-debugger-details' });

    details.createEl('div', {
      text: `GUID: ${state.guid}`,
      cls: 'hsm-detail-item',
    });
    details.createEl('div', {
      text: `Path: ${state.path}`,
      cls: 'hsm-detail-item',
    });

    if (state.lca) {
      details.createEl('div', {
        text: `LCA mtime: ${new Date(state.lca.meta.mtime).toLocaleTimeString()}`,
        cls: 'hsm-detail-item',
      });
    }

    if (state.disk) {
      details.createEl('div', {
        text: `Disk mtime: ${new Date(state.disk.mtime).toLocaleTimeString()}`,
        cls: 'hsm-detail-item',
      });
    }

    if (state.error) {
      details.createEl('div', {
        text: `Error: ${state.error.message}`,
        cls: 'hsm-detail-item hsm-error',
      });
    }
  }

  private renderTabs(container: Element): void {
    const tabs = container.createEl('div', { cls: 'hsm-debugger-tabs' });

    // Tab buttons
    const tabBar = tabs.createEl('div', { cls: 'hsm-debugger-tab-bar' });

    const eventTab = tabBar.createEl('button', {
      text: `Events (${this.data.recentEvents.length})`,
      cls: 'hsm-tab-btn active',
    });
    const effectTab = tabBar.createEl('button', {
      text: `Effects (${this.data.recentEffects.length})`,
      cls: 'hsm-tab-btn',
    });
    const violationTab = tabBar.createEl('button', {
      text: `Violations (${this.data.recentViolations.length})`,
      cls: 'hsm-tab-btn',
    });

    // Tab content
    const content = tabs.createEl('div', { cls: 'hsm-debugger-tab-content' });

    // Event tab (default)
    const eventContent = this.renderEventList();
    content.appendChild(eventContent);

    // Tab switching
    const setActiveTab = (btn: HTMLButtonElement, contentEl: Element) => {
      tabBar.querySelectorAll('.hsm-tab-btn').forEach((b) => b.removeClass('active'));
      btn.addClass('active');
      content.empty();
      content.appendChild(contentEl);
    };

    eventTab.addEventListener('click', () => setActiveTab(eventTab, this.renderEventList()));
    effectTab.addEventListener('click', () => setActiveTab(effectTab, this.renderEffectList()));
    violationTab.addEventListener('click', () => setActiveTab(violationTab, this.renderViolationList()));
  }

  private renderEventList(): Element {
    const list = document.createElement('div');
    list.addClass('hsm-debugger-list');

    if (this.data.recentEvents.length === 0) {
      list.createEl('p', { text: 'No events yet', cls: 'hsm-list-empty' });
      return list;
    }

    for (const entry of this.data.recentEvents) {
      const item = list.createEl('div', { cls: 'hsm-list-item' });
      item.createEl('span', {
        text: entry.event.type,
        cls: 'hsm-event-type',
      });
      item.createEl('span', {
        text: `${entry.stateBefore} → ${entry.stateAfter}`,
        cls: 'hsm-event-transition',
      });
      item.createEl('span', {
        text: new Date(entry.timestamp).toLocaleTimeString(),
        cls: 'hsm-event-time',
      });
    }

    return list;
  }

  private renderEffectList(): Element {
    const list = document.createElement('div');
    list.addClass('hsm-debugger-list');

    if (this.data.recentEffects.length === 0) {
      list.createEl('p', { text: 'No effects yet', cls: 'hsm-list-empty' });
      return list;
    }

    for (const entry of this.data.recentEffects) {
      const item = list.createEl('div', { cls: 'hsm-list-item' });
      item.createEl('span', {
        text: entry.effect.type,
        cls: 'hsm-effect-type',
      });
      item.createEl('span', {
        text: new Date(entry.timestamp).toLocaleTimeString(),
        cls: 'hsm-effect-time',
      });
    }

    return list;
  }

  private renderViolationList(): Element {
    const list = document.createElement('div');
    list.addClass('hsm-debugger-list');

    if (this.data.recentViolations.length === 0) {
      list.createEl('p', { text: 'No violations', cls: 'hsm-list-empty' });
      return list;
    }

    for (const violation of this.data.recentViolations) {
      const item = list.createEl('div', { cls: `hsm-list-item hsm-violation-${violation.severity}` });
      item.createEl('span', {
        text: `[${violation.severity.toUpperCase()}] ${violation.invariantId}`,
        cls: 'hsm-violation-type',
      });
      item.createEl('span', {
        text: violation.message,
        cls: 'hsm-violation-message',
      });
    }

    return list;
  }

  private getStateClass(statePath: StatePath): string {
    if (statePath.startsWith('active.conflict')) return 'hsm-state-conflict';
    if (statePath.startsWith('active')) return 'hsm-state-active';
    if (statePath.startsWith('idle.error')) return 'hsm-state-error';
    if (statePath.startsWith('idle')) return 'hsm-state-idle';
    if (statePath.startsWith('loading')) return 'hsm-state-loading';
    return 'hsm-state-default';
  }
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Open the HSM debugger in the right sidebar.
 */
export async function openHSMDebugger(workspace: Workspace): Promise<HSMDebuggerView | null> {
  // Check if already open
  const existing = workspace.getLeavesOfType(HSM_DEBUGGER_VIEW_TYPE);
  if (existing.length > 0) {
    workspace.revealLeaf(existing[0]);
    return existing[0].view as HSMDebuggerView;
  }

  // Open in right sidebar
  const leaf = workspace.getRightLeaf(false);
  if (!leaf) return null;

  await leaf.setViewState({
    type: HSM_DEBUGGER_VIEW_TYPE,
    active: true,
  });

  workspace.revealLeaf(leaf);
  return leaf.view as HSMDebuggerView;
}
