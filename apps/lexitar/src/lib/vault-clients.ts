import type { Client, Vault } from "./types";

export function withClient(vault: Vault, id: string, client: Client): Vault {
  return { clients: { ...vault.clients, [id]: client } };
}
