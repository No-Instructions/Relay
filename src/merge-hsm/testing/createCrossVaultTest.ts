/**
 * Cross-Vault Test Fixture
 *
 * Simulates two vaults syncing through a shared Y.Doc "server" without
 * live Obsidian instances. Each vault has its own MergeHSM, localDoc,
 * remoteDoc, and simulated disk. The server Y.Doc acts as the relay,
 * propagating updates between vaults when sync() is called.
 */

import * as Y from 'yjs';
import { createTestHSM } from './createTestHSM';
import type { TestHSM } from './createTestHSM';
import type { MergeEffect } from '../types';
import { ProviderIntegration } from '../integration/ProviderIntegration';
import { reconnectProvider } from '../integration/ProviderLifecycle';
import { MockYjsProvider } from './MockYjsProvider';

// =============================================================================
// Types
// =============================================================================

export interface SimulatedDisk {
  content: string | null;
  mtime: number;
}

export interface VaultHandle {
  /** The underlying TestHSM */
  hsm: TestHSM;
  /** Simulated disk state */
  disk: SimulatedDisk;
  /** Shortcut: send event to HSM */
  send: TestHSM['send'];
  /** Simulate user typing (sends CM6_CHANGE; HSM applies to localDoc) */
  editText(newText: string): void;
  /** Simulate external disk write (generates DISK_CHANGED event) */
  writeFile(content: string): Promise<void>;
  /** All effects emitted by this vault's HSM */
  readonly effects: MergeEffect[];
  /** Clear effects */
  clearEffects(): void;
  /** Get current local doc text */
  getLocalText(): string | null;
  /** Get current remote doc text */
  getRemoteText(): string | null;
  /** Disconnect from server (stop propagating updates) */
  disconnect(): void;
  /** Reconnect to server */
  reconnect(): void;
  /** Whether this vault is connected to the server */
  connected: boolean;
  /** MockYjsProvider (only present when useProviderIntegration is true) */
  provider?: MockYjsProvider;
  /** ProviderIntegration (only present when useProviderIntegration is true) */
  integration?: ProviderIntegration;
}

export interface CrossVaultTestOptions {
  /** Wire up real ProviderIntegration + MockYjsProvider per vault */
  useProviderIntegration?: boolean;
}

export interface CrossVaultTest {
  vaultA: VaultHandle;
  vaultB: VaultHandle;
  /** The server Y.Doc that relays updates between vaults */
  server: Y.Doc;
  /** Propagate all pending updates between vaults through the server */
  sync(): void;
  /** Tear down all resources */
  destroy(): void;
}

// =============================================================================
// Factory
// =============================================================================

export async function createCrossVaultTest(options: CrossVaultTestOptions = {}): Promise<CrossVaultTest> {
  const server = new Y.Doc();

  // Both vaults share the same document GUID (same file, two vaults)
  const docGuid = 'cross-vault-doc';

  const hsmA = await createTestHSM({
    guid: docGuid,
    path: 'shared.md',
    vaultId: 'vault-A',
  });

  const hsmB = await createTestHSM({
    guid: docGuid,
    path: 'shared.md',
    vaultId: 'vault-B',
  });

  const diskA: SimulatedDisk = { content: null, mtime: 0 };
  const diskB: SimulatedDisk = { content: null, mtime: 0 };

  // Connection state
  let aConnected = true;
  let bConnected = true;

  // Pending update queues
  const pendingFromA: Uint8Array[] = [];
  const pendingFromB: Uint8Array[] = [];
  const pendingFromServer: { target: 'A' | 'B'; update: Uint8Array }[] = [];

  const remoteDocA = hsmA.hsm.getRemoteDoc()!;
  const remoteDocB = hsmB.hsm.getRemoteDoc()!;

  // Flags to prevent echo loops at each layer
  let applyingToVaults = false;

  remoteDocA.on('update', (update: Uint8Array, origin: any) => {
    if (applyingToVaults || origin === 'server') return;
    pendingFromA.push(update);
  });

  remoteDocB.on('update', (update: Uint8Array, origin: any) => {
    if (applyingToVaults || origin === 'server') return;
    pendingFromB.push(update);
  });

  // Server listener captures updates for relay to vaults.
  // This must NOT be gated by `applyingToVaults` — it needs to fire
  // when vaults push to the server.
  server.on('update', (update: Uint8Array, origin: any) => {
    if (origin === 'vaultA') {
      pendingFromServer.push({ target: 'B', update });
    } else if (origin === 'vaultB') {
      pendingFromServer.push({ target: 'A', update });
    }
  });

  // Indirection so ProviderIntegration mode can override sync behavior
  let syncFn: () => void;

  function sync() {
    for (let round = 0; round < 5; round++) {
      const hadWork = pendingFromA.length > 0 || pendingFromB.length > 0 || pendingFromServer.length > 0;
      if (!hadWork) break;

      // Phase 1: Drain vault remoteDocs → server
      while (aConnected && pendingFromA.length > 0) {
        Y.applyUpdate(server, pendingFromA.shift()!, 'vaultA');
      }
      while (bConnected && pendingFromB.length > 0) {
        Y.applyUpdate(server, pendingFromB.shift()!, 'vaultB');
      }

      // Phase 2: Drain server → vault remoteDocs + send REMOTE_UPDATE events
      applyingToVaults = true;
      try {
        const serverUpdates = pendingFromServer.splice(0);
        for (const { target, update } of serverUpdates) {
          if (target === 'A' && aConnected) {
            Y.applyUpdate(remoteDocA, update, 'server');
            hsmA.send({ type: 'REMOTE_UPDATE', update });
          } else if (target === 'B' && bConnected) {
            Y.applyUpdate(remoteDocB, update, 'server');
            hsmB.send({ type: 'REMOTE_UPDATE', update });
          }
        }
      } finally {
        applyingToVaults = false;
      }
    }
  }

  syncFn = sync;

  // Track WRITE_DISK effects to update simulated disks
  hsmA.hsm.subscribe((effect: MergeEffect) => {
    if (effect.type === 'WRITE_DISK') {
      diskA.content = effect.contents;
      diskA.mtime = effect.mtime ?? Date.now();
    }
  });

  hsmB.hsm.subscribe((effect: MergeEffect) => {
    if (effect.type === 'WRITE_DISK') {
      diskB.content = effect.contents;
      diskB.mtime = Date.now();
    }
  });

  function createVaultHandle(
    hsm: TestHSM,
    disk: SimulatedDisk,
    remoteDoc: Y.Doc,
    getConnected: () => boolean,
    setConnected: (v: boolean) => void,
  ): VaultHandle {
    return {
      hsm,
      disk,
      send: hsm.send.bind(hsm),
      effects: hsm.effects,
      clearEffects: () => hsm.clearEffects(),
      getLocalText: () => hsm.getLocalDocText(),
      getRemoteText: () => hsm.getRemoteDocText(),
      get connected() { return getConnected(); },
      set connected(v: boolean) { setConnected(v); },

      editText(newText: string) {
        // Simulate a user edit by computing the diff and sending CM6_CHANGE.
        // The HSM's applyCM6ToLocalDoc action applies changes to localDoc
        // and flushes outbound to remoteDoc (mirroring the real CM6 flow).
        const localDoc = hsm.hsm.getLocalDoc();
        if (!localDoc) throw new Error('localDoc not available (HSM not in active mode)');

        const currentText = localDoc.getText('contents').toString();
        if (currentText === newText) return;

        // Compute diff via common prefix/suffix
        let prefixLen = 0;
        while (prefixLen < currentText.length && prefixLen < newText.length
          && currentText[prefixLen] === newText[prefixLen]) {
          prefixLen++;
        }
        let suffixLen = 0;
        while (suffixLen < currentText.length - prefixLen
          && suffixLen < newText.length - prefixLen
          && currentText[currentText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]) {
          suffixLen++;
        }

        const from = prefixLen;
        const to = currentText.length - suffixLen;
        const insert = newText.slice(prefixLen, newText.length - suffixLen);

        hsm.send({ type: 'CM6_CHANGE', changes: [{ from, to, insert }], docText: newText });
      },

      async writeFile(content: string) {
        disk.content = content;
        disk.mtime = Date.now();

        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        hsm.send({
          type: 'DISK_CHANGED',
          contents: content,
          mtime: disk.mtime,
          hash,
        });
      },

      disconnect() {
        setConnected(false);
        hsm.send({ type: 'DISCONNECTED' });
      },

      reconnect() {
        setConnected(true);

        // Simulate provider sync: pull server state into remoteDoc
        // (like the WebSocket provider does on reconnection)
        const serverUpdate = Y.encodeStateAsUpdate(server, Y.encodeStateVector(remoteDoc));
        if (serverUpdate.length > 0) {
          applyingToVaults = true;
          try {
            Y.applyUpdate(remoteDoc, serverUpdate, 'server');
          } finally {
            applyingToVaults = false;
          }
          hsm.send({ type: 'REMOTE_UPDATE', update: serverUpdate });
        }

        hsm.send({ type: 'CONNECTED' });
        hsm.send({ type: 'PROVIDER_SYNCED' });
      },
    };
  }

  const vaultA = createVaultHandle(hsmA, diskA, remoteDocA, () => aConnected, (v) => { aConnected = v; });
  const vaultB = createVaultHandle(hsmB, diskB, remoteDocB, () => bConnected, (v) => { bConnected = v; });

  // Wire up ProviderIntegration if requested
  if (options.useProviderIntegration) {
    const providerA = new MockYjsProvider(remoteDocA, server);
    const providerB = new MockYjsProvider(remoteDocB, server);

    const integrationA = new ProviderIntegration(hsmA.hsm as any, remoteDocA, providerA);
    const integrationB = new ProviderIntegration(hsmB.hsm as any, remoteDocB, providerB);

    vaultA.provider = providerA;
    vaultA.integration = integrationA;
    vaultB.provider = providerB;
    vaultB.integration = integrationB;

    // Override disconnect/reconnect to go through the mock provider
    vaultA.disconnect = () => {
      aConnected = false;
      vaultA.provider!.disconnect();
    };
    vaultA.reconnect = () => {
      aConnected = true;
      const result = reconnectProvider({
        hsm: hsmA.hsm as any,
        integration: vaultA.integration ?? null,
        createFreshRemoteDoc: () => new Y.Doc(),
        destroyCurrentRemoteDoc: () => {
          hsmA.hsm.setRemoteDoc(null as any);
        },
        createAndConnectProvider: (remoteDoc) => {
          const provider = new MockYjsProvider(remoteDoc, server);
          provider.connect();
          vaultA.provider = provider;
          return provider;
        },
      });
      vaultA.integration = result.integration;
      vaultA.provider!.pushToServer('vaultA');
    };
    vaultB.disconnect = () => {
      bConnected = false;
      vaultB.provider!.disconnect();
    };
    vaultB.reconnect = () => {
      bConnected = true;
      const result = reconnectProvider({
        hsm: hsmB.hsm as any,
        integration: vaultB.integration ?? null,
        createFreshRemoteDoc: () => new Y.Doc(),
        destroyCurrentRemoteDoc: () => {
          hsmB.hsm.setRemoteDoc(null as any);
        },
        createAndConnectProvider: (remoteDoc) => {
          const provider = new MockYjsProvider(remoteDoc, server);
          provider.connect();
          vaultB.provider = provider;
          return provider;
        },
      });
      vaultB.integration = result.integration;
      vaultB.provider!.pushToServer('vaultB');
    };

    // Override syncFn to route through providers (uses current provider/remoteDoc
    // from vault handles since reconnect() replaces them)
    syncFn = function providerSync() {
      const curProviderA = vaultA.provider!;
      const curProviderB = vaultB.provider!;
      const curRemoteDocA = hsmA.hsm.getRemoteDoc()!;
      const curRemoteDocB = hsmB.hsm.getRemoteDoc()!;

      // First: push vault remoteDocs to server via providers
      if (aConnected) curProviderA.pushToServer('vaultA');
      if (bConnected) curProviderB.pushToServer('vaultB');

      // Then: pull server updates into each vault's remoteDoc via provider
      if (aConnected) {
        const updateForA = Y.encodeStateAsUpdate(server, Y.encodeStateVector(curRemoteDocA));
        if (updateForA.length > 2) {
          curProviderA.receiveServerUpdate(updateForA);
        }
      }
      if (bConnected) {
        const updateForB = Y.encodeStateAsUpdate(server, Y.encodeStateVector(curRemoteDocB));
        if (updateForB.length > 2) {
          curProviderB.receiveServerUpdate(updateForB);
        }
      }
    };
  }

  return { vaultA, vaultB, server, sync: () => syncFn(), destroy() { server.destroy(); } };
}
