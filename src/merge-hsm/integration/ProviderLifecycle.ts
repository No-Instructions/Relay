/**
 * ProviderLifecycle - Extracted provider reconnection logic
 *
 * Encapsulates the destroy-old → create-fresh → reconnect lifecycle that both
 * Document (production) and test fixtures share. Obsidian-specific parts
 * (provider creation, auth) are injected via the ProviderLifecycleHost interface.
 */

import * as Y from 'yjs';
import type { MergeHSM } from '../MergeHSM';
import { ProviderIntegration, type YjsProvider } from './ProviderIntegration';

// =============================================================================
// Host Interface
// =============================================================================

export interface ProviderLifecycleHost {
  hsm: MergeHSM;
  integration: ProviderIntegration | null;
  createFreshRemoteDoc(): Y.Doc;
  destroyCurrentRemoteDoc(): void;
  createAndConnectProvider(remoteDoc: Y.Doc): YjsProvider;
}

// =============================================================================
// Reconnect Function
// =============================================================================

/**
 * Tear down the old provider integration and remoteDoc, create fresh ones,
 * and wire up a new ProviderIntegration.
 *
 * Steps:
 * 1. Destroy old integration (unsubscribes from provider/HSM events)
 * 2. Destroy old remoteDoc (resets providerSynced via setRemoteDoc(null))
 * 3. Create fresh remoteDoc and wire into HSM
 * 4. Create provider and connect
 * 5. Create new ProviderIntegration
 */
export function reconnectProvider(host: ProviderLifecycleHost): {
  integration: ProviderIntegration;
  remoteDoc: Y.Doc;
} {
  // 1. Destroy old integration
  if (host.integration) {
    host.integration.destroy();
  }

  // 2. Destroy old remoteDoc (resets providerSynced via setRemoteDoc(null))
  host.destroyCurrentRemoteDoc();

  // 3. Create fresh remoteDoc + wire into HSM
  const remoteDoc = host.createFreshRemoteDoc();
  host.hsm.setRemoteDoc(remoteDoc);

  // 4. Create provider and connect
  const provider = host.createAndConnectProvider(remoteDoc);

  // 5. Create new ProviderIntegration
  const integration = new ProviderIntegration(host.hsm, remoteDoc, provider);

  // 6. If the provider already synced data into remoteDoc during connect
  // (before ProviderIntegration was listening), send the full state as a
  // REMOTE_UPDATE so the HSM can process it.
  const fullUpdate = Y.encodeStateAsUpdate(remoteDoc);
  if (fullUpdate.length > 2) {
    host.hsm.send({ type: 'REMOTE_UPDATE', update: fullUpdate });
  }

  return { integration, remoteDoc };
}
