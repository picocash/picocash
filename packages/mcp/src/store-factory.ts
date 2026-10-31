import { EngramProofStore, FileProofStore, MemoryProofStore, Relay, type ProofStore } from '@picocash/sdk';
import type { McpConfig } from './config.js';

export function buildStore(config: McpConfig): ProofStore {
  switch (config.store.kind) {
    case 'memory':
      return new MemoryProofStore();
    case 'file':
      return new FileProofStore(config.store.path);
    case 'engram':
      return new EngramProofStore({
        relay: new Relay(config.store.relayUrl, { authKey: config.privkey }),
        agentPrivkey: config.privkey,
        ownerPubkey: config.store.ownerPubkey,
      });
  }
}
