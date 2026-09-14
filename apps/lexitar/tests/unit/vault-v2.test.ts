// ORG_KEY_PASSPHRASE (opens the real committed org key, records/org-key.json) is loaded from the
// operator's private credential store by tests/setup.ts (vitest setupFiles), not hardcoded here.
import { describe, it, expect } from "vitest";
import { isV2, sidecarPathFor, buildV2, openV2 } from "../../scripts/vault-v2";
import { encryptVault } from "@tinytars/vault/crypto";

// W44 cutover — proves the shared v2 helpers round-trip against the REAL committed org key
// (records/org-key.json), not a throwaway one, so a broken/rotated committed key fails here
// first rather than surfacing later in migrate-accounts or vault:verify.
describe("vault-v2", () => {
  it("buildV2 → openV2 round-trips a sample object via the committed org key", async () => {
    const sample = { hello: "world", n: 42, nested: { a: [1, 2, 3] } };
    const { blob, sidecar } = await buildV2(sample);
    const back = await openV2<typeof sample>(blob, sidecar);
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
    await expect(openV2(blob, badSidecar)).rejects.toThrow();
  });

  it("sidecarPathFor maps a .enc path to its .dek.enc sidecar", () => {
    expect(sidecarPathFor("/x/records/public/data-alex.enc")).toBe("/x/records/public/data-alex.dek.enc");
  });
});
