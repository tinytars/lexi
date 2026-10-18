// A throwaway org keypair on disk, in the exact shape scripts/org-key.ts loads.
//
// WHY A TEST MINTS ITS OWN. tests/unit/vault-v2.test.ts used to round-trip against the REAL org key,
// on the premise that it was committed at records/org-key.json — and that premise is the one this
// remediation exists to withdraw, because the private half of a key holding a recovery envelope on
// every vault was published for 22 days. With the key resolving from the operator's credential store
// there is nothing for a stranger's clone to load, so the suite minted a dependency on a machine
// instead of on a fixture.
//
// WHAT IS GIVEN UP, SAID HERE RATHER THAN DISCOVERED. That test was also, incidentally, the only
// thing asserting the operator's own org-key.json and ORG_KEY_PASSPHRASE agree — and they did not,
// measured 2026-10-06: health-dash.env's value opens the RETIRED key and fails on the current one.
// A fixture cannot check that, and a test that skips without a credential is indistinguishable from
// one that passes, which is why vitest.config.ts refused to skipIf it. Phase 3(e2) of the
// remediation reconciles the store; the check belongs to an operator command, not to this suite.
//
// It writes through the same primitives scripts/gen-org-key.ts does and the caller reads it back
// through the real loader, so a drift in OrgKeyFile's shape fails rather than passing on a fixture
// the production code could not open.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAccountKeypair, deriveKekFromPassword, wrapPrivateKey } from "@tinytars/vault/crypto";
import { SALT_LEN, PBKDF2_ITERATIONS } from "@tinytars/vault/kdf";
import type { OrgKeyFile } from "../../scripts/org-key";

/**
 * Writes a fresh org key file to a temporary directory and returns its path and passphrase.
 * The caller sets ORG_KEY_PATH and ORG_KEY_PASSPHRASE from it BEFORE importing anything that
 * reaches scripts/org-key.ts — ORG_KEY_PATH is resolved once, at module load.
 */
export async function mintThrowawayOrgKey(): Promise<{ path: string; passphrase: string }> {
  const pair = await generateAccountKeypair();
  const passphrase = "throwaway-org-key-passphrase";
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const wrapped = await wrapPrivateKey(pair.privateKey, await deriveKekFromPassword(passphrase, salt));
  const file: OrgKeyFile = {
    publicKeyJwk: pair.publicKeyJwk,
    wrappedPrivateKey: Buffer.from(wrapped).toString("base64"),
    kdfParams: { salt: Buffer.from(salt).toString("hex"), iterations: PBKDF2_ITERATIONS },
    createdAt: new Date().toISOString(),
  };
  const path = join(mkdtempSync(join(tmpdir(), "lexitar-org-key-")), "org-key.json");
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { path, passphrase };
}
