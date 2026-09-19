import type { Vault } from "./types";

// Every leaf list renders in an {#each} keyed on `id`, so a missing or repeated id throws
// each_key_duplicate. Rows predating M71's ids (or written by a path that minted none) still reach
// live vaults, so the guarantee is made on every decrypt rather than trusted to a one-off backfill.
export function ensureLeafIds(vault: Vault): Vault {
  for (const client of Object.values(vault.clients)) {
    const f = client.factors;
    const lists: { id?: string }[][] = [
      f?.diseases ?? [], f?.treatments ?? [], f?.allergies ?? [], f?.familyHistory ?? [],
      f?.decisions ?? [], f?.noteEntries ?? [], client.study?.entries ?? [],
    ];
    for (const list of lists) {
      const seen = new Set<string>();
      for (const row of list) {
        if (!row.id || seen.has(row.id)) row.id = crypto.randomUUID();
        seen.add(row.id);
      }
    }
  }
  return vault;
}
