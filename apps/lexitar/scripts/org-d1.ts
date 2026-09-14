// W44 P4c — the org-recovery envelope, read from remote D1 (the source of truth once vaults can be
// re-keyed by a client rotation). `reconcile` pulls the current R2 blob, whose DEK may have been rotated;
// the committed `.dek.enc` file sidecar can lag, so the DEK is sourced from D1's `vault_envelopes` org row
// instead. For an un-rotated vault this returns the exact same envelope as the committed sidecar.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { OrgSidecar } from "./vault-v2";
import { wranglerTarget } from "./target";

const here = dirname(fileURLToPath(import.meta.url));
const WRANGLER = resolve(here, "wrangler.sh");
const ORG_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
// W53 P4: derived from the worktree's wrangler.jsonc — see scripts/target.ts.
const DB = wranglerTarget().database;

// Fetch the org-recovery envelope for the vault whose r2_key is `data-{id}.enc`. Uses the committed
// wrangler wrapper (CA + token from .cloudflare.env). Returns an OrgSidecar (same shape the file used).
export function orgSidecarFromD1(id: string): OrgSidecar {
  const r2Key = `data-${id}.enc`;
  const sql =
    `SELECT hex(e.wrapped_dek) AS wrapped_hex, e.ephemeral_public_key_jwk AS eph ` +
    `FROM vault_envelopes e JOIN vaults v ON e.vault_id = v.vault_id ` +
    `WHERE v.r2_key = '${r2Key}' AND e.principal_account_id = '${ORG_ACCOUNT_ID}';`;
  const out = execFileSync("bash", [WRANGLER, "d1", "execute", DB, "--remote", "--json", "--command", sql], {
    encoding: "utf8",
  });
  // wrangler --json prints [{ results: [ { wrapped_hex, eph } ], success, meta }]
  const parsed = JSON.parse(out) as { results: { wrapped_hex: string; eph: string }[] }[];
  const row = parsed[0]?.results?.[0];
  if (!row) throw new Error(`no org-recovery envelope in D1 for ${r2Key} (vault not migrated/seeded?)`);
  const wrappedDEK = Buffer.from(row.wrapped_hex, "hex").toString("base64");
  return { wrappedDEK, ephemeralPublicKeyJwk: JSON.parse(row.eph) as JsonWebKey };
}
