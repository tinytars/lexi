// THE ONLY CODE IN THIS TREE THAT TURNS THE ORG OPERATIONAL KEY INTO A DECRYPTION KEY.
//
// VAULT.md §2 permits an operator read on condition that every use is logged. That condition used to
// be a request: each decrypt site loaded the key itself and was asked, by a comment, to call
// `recordOrgKeyUse` alongside it — and two sites (raw-backfill.ts, recovery-approve.ts) never did. So
// the request is a mechanism here instead. This module is the sole importer of `loadOrgPrivateKey`, it
// writes the audit entry itself before it returns a key, and tests/unit/org-key-chokepoint.test.ts
// fails the build when another file reintroduces the shortcut.
//
// The id audited is the vault's `r2_key` STEM, not the client slug — access-log.ts looks the vault up
// by `data-{id}.enc` and would find no row for a slug. It is validated BEFORE any crypto happens, so
// a use that could not be logged fails before the key exists.
//
// What this does not claim: anyone holding `ORG_KEY_PASSPHRASE` and `records/org-key.json` can write
// their own twenty lines. The property is about this repository, not about the machine — the same
// distinction ARCHITECTURE.md draws between the server enforcing access and the server being able to
// read.

import { unwrapDEKWithPrivateKey } from "@tinytars/vault/crypto";
import { loadOrgPrivateKey, b64ToBytes } from "./org-key";
import { CLIENT_ID_RE, recordOrgKeyUse } from "./access-log";

/** An org-recovery envelope, in the one shape this tree already stores it in (OrgSidecar, org-d1.ts). */
export interface OrgEnvelope {
  wrappedDEK: string;
  ephemeralPublicKeyJwk: JsonWebKey;
}

export interface OrgKeyAudit {
  /** The vault's `r2_key` stem, i.e. the `{id}` in `data-{id}.enc`. */
  vaultId: string;
  purpose: string;
}

/** D1 stores the envelope as a blob; `hex(wrapped_dek)` plus the JWK text is what every query selects. */
export function envelopeFromHex(wrappedHex: string, ephemeralPublicKeyJwk: string): OrgEnvelope {
  return {
    wrappedDEK: Buffer.from(wrappedHex, "hex").toString("base64"),
    ephemeralPublicKeyJwk: JSON.parse(ephemeralPublicKeyJwk) as JsonWebKey,
  };
}

// Cached per run, so a store-wide sweep loads and unwraps the org key once rather than once per file.
let orgKey: CryptoKey | undefined;

export async function unwrapVaultDEK(
  envelope: OrgEnvelope,
  audit: OrgKeyAudit,
  passphrase?: string,
): Promise<CryptoKey> {
  if (!CLIENT_ID_RE.test(audit.vaultId)) {
    throw new Error(`org-unwrap: refusing to unwrap for non-slug vaultId "${audit.vaultId}" — it cannot be audited`);
  }
  recordOrgKeyUse({ clientId: audit.vaultId, purpose: audit.purpose });
  orgKey ??= await loadOrgPrivateKey(passphrase);
  return unwrapDEKWithPrivateKey(b64ToBytes(envelope.wrappedDEK), envelope.ephemeralPublicKeyJwk, orgKey);
}
