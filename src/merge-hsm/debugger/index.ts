/**
 * HSM Debugger Module
 *
 * Visual debugging panel for MergeHSM.
 *
 * Usage:
 *   import { HSMDebuggerView, HSM_DEBUGGER_VIEW_TYPE, openHSMDebugger } from './debugger';
 *
 *   // Register the view
 *   plugin.registerView(HSM_DEBUGGER_VIEW_TYPE, (leaf) => new HSMDebuggerView(leaf));
 *
 *   // Open the debugger
 *   const view = await openHSMDebugger(workspace);
 *   view.setCallbacks(callbacks);
 */

export {
  HSMDebuggerView,
  HSM_DEBUGGER_VIEW_TYPE,
  openHSMDebugger,
} from './HSMDebuggerView';

// Note: Import styles.css in your main plugin file:
// import './merge-hsm/debugger/styles.css';
