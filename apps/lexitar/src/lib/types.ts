export * from "@pablotech/akesi-pil/types";

import type { Client } from "@pablotech/akesi-pil/types";

export interface Vault {
  clients: Record<string, Client>;
}

// Provider-level directory stored in records/roster.enc (passphrase = provider key). CLI-only —
// never served; the browser's patient list is /api/providers/patients.
// Lists clients by display name only — no clinical or demographic data.
// Each client's actual data lives solely in its own data-{id}.enc vault.
export interface RosterEntry {
  displayName: string;
}

export interface Roster {
  kind: "roster";
  clients: Record<string, RosterEntry>;
}
