/**
 * MergeHSM Integration Module
 *
 * Provides integration classes for connecting MergeHSM to external systems:
 * - CM6Integration: CodeMirror 6 editor integration
 * - ProviderIntegration: YSweet/WebSocket provider integration
 * - DiskIntegration: Filesystem/vault integration
 */

export { CM6Integration } from './CM6Integration';
export { ProviderIntegration } from './ProviderIntegration';
export type { YjsProvider } from './ProviderIntegration';
export { DiskIntegration } from './DiskIntegration';
export type { Vault, HashFn } from './DiskIntegration';
