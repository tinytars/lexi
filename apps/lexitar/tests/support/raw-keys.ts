import { setRawKeySink, withRawKey } from "../../src/lib/vault-raw-keys";
import type { Vault } from "../../src/lib/types";

/**
 * An open vault for the content-key ring, the way App.svelte's `$effect` registers one.
 *
 * Needed by any test that uploads: `putRaw` seals, and it refuses outright when there is no vault to
 * record the key in, because /api/raw no longer accepts plaintext. Call it per test rather than in a
 * global hook — the absence of a vault is itself a case worth pinning.
 */
export function openTestVault(): void {
  let vault = { clients: {} } as Vault;
  setRawKeySink(async (id, file, key) => void (vault = withRawKey(vault, id, file, key)));
}
