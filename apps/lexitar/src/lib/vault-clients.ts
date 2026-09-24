import type { Client, Vault } from "./types";

export function withClient(vault: Vault, id: string, client: Client): Vault {
  // Spread the vault, not just its clients: anything else stored beside `clients` — the rawKeys
  // key ring — would be silently dropped on the next record edit, which loses the only copy.
  return { ...vault, clients: { ...vault.clients, [id]: client } };
}
