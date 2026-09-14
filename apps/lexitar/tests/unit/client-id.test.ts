import { describe, it, expect } from "vitest";
import { normalizeClientId, vaultIdFromR2Key } from "../../src/lib/client-id";

describe("normalizeClientId", () => {
  it("lowercases, so a uuid compares equal however it was cased", () => {
    expect(normalizeClientId("834BC60D-C937-467D-9E78-3CAA734ACF45")).toBe(
      "834bc60d-c937-467d-9e78-3caa734acf45",
    );
  });
});

describe("vaultIdFromR2Key", () => {
  it("reads the vault id a blob key encodes", () => {
    expect(vaultIdFromR2Key("data-834bc60d-c937-467d-9e78-3caa734acf45.enc")).toBe(
      "834bc60d-c937-467d-9e78-3caa734acf45",
    );
  });

  // The case the three former copies disagreed on: the strip-based one (`.replace(/^data-/,"")
  // .replace(/\.enc$/,"")`) returned a truthy id for keys that are not vault blobs at all, so a
  // caller testing its result could route a chat blob's own key back through /api/vault/{id}.
  it("returns null for a key that is not a vault blob", () => {
    expect(vaultIdFromR2Key("chat-834bc60d.enc")).toBeNull();
    expect(vaultIdFromR2Key("roster.json")).toBeNull();
  });

  // Stated rather than hidden: `.+` is greedy, so a sidecar key yields a bogus id rather than null.
  // Harmless because `vaults.r2_key` is only ever the blob, and tightening it would change what
  // erasure.ts enumerates — which is not a change to make without a reason to.
  it("does not special-case the .dek sidecar", () => {
    expect(vaultIdFromR2Key("data-834bc60d.dek.enc")).toBe("834bc60d.dek");
  });
});
