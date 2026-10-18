export * from "@pablotech/akesi/types";

import type { Client } from "@pablotech/akesi/types";

export interface Vault {
  clients: Record<string, Client>;
  /**
   * The content keys that open this vault's stored originals: clientId → file name → base64 key.
   *
   * Beside `clients` rather than on a Client because Client is `@pablotech/akesi`'s type and a key
   * ring is this app's storage concern, not the record's clinical shape. Optional: a vault written
   * before raw objects were sealed has none, and every reader tolerates both formats.
   */
  rawKeys?: Record<string, Record<string, string>>;
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
