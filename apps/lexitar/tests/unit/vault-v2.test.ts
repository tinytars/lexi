// The shared v2 helpers, round-tripped against an org key this file mints itself.
//
// IT USED TO NEED THE OPERATOR'S OWN KEY, and that is the dependency this remediation removes. The
// header here read "ORG_KEY_PASSPHRASE (opens the real committed org key, records/org-key.json)" —
// and a committed org key is the incident: its private half holds a recovery envelope on every
// vault and it was public for 22 days. scripts/org-key.ts no longer has a path into this
// repository at all, so this suite asked a stranger's clone for a credential store it has no
// reason to own. tests/support/org-key-file.ts says what that trade gives up, which is not nothing.
//
// ORG_KEY_PATH IS RESOLVED ONCE, AT MODULE LOAD (scripts/org-key.ts:29), so the environment is set
// before the dynamic import below rather than in a beforeAll that would run after it.
import { describe, it, expect } from "vitest";
import { encryptVault } from "@tinytars/vault/crypto";
import { mintThrowawayOrgKey } from "../support/org-key-file";

const key = await mintThrowawayOrgKey();
process.env.ORG_KEY_PATH = key.path;
process.env.ORG_KEY_PASSPHRASE = key.passphrase;

// Read back through the REAL loader, so a drift between the fixture's shape and OrgKeyFile fails
// here instead of passing against bytes the production code could not open.
const { isV2, sidecarPathFor, buildV2, openV2 } = await import("../../scripts/vault-v2");

// openV2 will not hand back a DEK without somewhere to record the use (scripts/org-unwrap.ts). These
// uses are never flushed, so they land in the spool under the XDG_STATE_HOME vitest.config.ts sets —
// a throwaway directory, never the operator's real audit backlog.
const AUDIT = { vaultId: "vault-v2-roundtrip", purpose: "test:vault-v2" };

describe("vault-v2", () => {
  it("buildV2 → openV2 round-trips a sample object via the org key on disk", async () => {
    const sample = { hello: "world", n: 42, nested: { a: [1, 2, 3] } };
    const { blob, sidecar } = await buildV2(sample);
    const back = await openV2<typeof sample>(blob, sidecar, AUDIT);
    expect(back).toEqual(sample);
  });

  it("isV2 detects a v2 blob's version byte and rejects a v1 blob", async () => {
    const { blob } = await buildV2({ x: 1 });
    expect(isV2(blob)).toBe(true);

    const v1blob = await encryptVault({ x: 1 }, "some-passphrase");
    expect(isV2(v1blob)).toBe(false);
  });

  it("openV2 rejects a tampered sidecar (flipped byte in wrappedDEK)", async () => {
    const { blob, sidecar } = await buildV2({ secret: "shh" });
    const tampered = Buffer.from(sidecar.wrappedDEK, "base64");
    tampered[0] ^= 0xff;
    const badSidecar = { ...sidecar, wrappedDEK: tampered.toString("base64") };
    await expect(openV2(blob, badSidecar, AUDIT)).rejects.toThrow();
  });

  it("sidecarPathFor maps a .enc path to its .dek.enc sidecar", () => {
    expect(sidecarPathFor("/x/records/public/data-alex.enc")).toBe("/x/records/public/data-alex.dek.enc");
  });
});
