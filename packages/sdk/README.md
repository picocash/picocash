# @picocash/sdk

Wallet-lite for agents (architecture component 5). **Stateless-capable**: the SDK holds no tokens — every method takes proofs and returns proofs, and storage is the caller's problem (a file, a DB row, a KV entry).

```ts
import { Wallet, verifyProofOffline } from '@picocash/sdk';

const wallet = new Wallet({ mintUrl: 'http://localhost:3338' });
const quote = await wallet.requestMintQuote(1_000_000);        // → pay quote.deposit on Tempo
// … transferWithMemo(deposit.to, amount, deposit.memo) …
const proofs = await wallet.mintProofs(quote.quote_id, 1_000_000); // DLEQ-verified, carries r

const { bundle, change } = await wallet.send(proofs, 250_000); // exact bundle + change
const claimed = await wallet.receive(bundle);                  // offline-verify, then own via swap
await wallet.meltProofs('0x…', claimed);                       // back to on-chain funds
```

Key properties:

- Every minted/swapped proof carries `dleq: {e, s, r}`, so **anyone** can verify it offline against the mint's published keys (`verifyProofOffline`) — the basis of agent-to-agent transfer and MPP accept-then-settle.
- Every signature from the mint is DLEQ-verified before the SDK trusts it; a mint that can't prove its signatures throws.
- `pcBindSecretHex` / `parsePcBindSecret` implement the canonical `PC-BIND` challenge-bound secrets from [spec/04](../../spec/04-mpp-method.md).
- Mint errors surface as `MintApiError` with the mint's machine-readable `code` and `recovery` hint.

Tests run against an in-process mint (no HTTP, no chain): `npm test`.
