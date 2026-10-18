import { describe, it, expect } from "vitest";
import { resolveClientKey } from "../../scripts/vault-ops";
import type { Vault } from "../../src/lib/types";

// The one non-obvious branch withDeployedClient relies on: a rekeyed vault (rekey-vault.ts) can
// leave the R2-key-derived id stale inside the ciphertext, so --client resolution must fall back
// to the vault's sole client rather than assume the id and the map key still agree.

const vaultWith = (clients: Record<string, unknown>) => ({ clients }) as unknown as Vault;

describe("resolveClientKey", () => {
  it("uses the exact vaultId key when present, even alongside other clients", () => {
    const vault = vaultWith({ alex: { displayName: "Alex" }, blair: { displayName: "Blair" } });
    expect(resolveClientKey(vault, "alex")).toBe("alex");
  });

  it("falls back to the sole client when the vaultId doesn't match its key", () => {
    const vault = vaultWith({ "834bc60d": { displayName: "Alex" } });
    expect(resolveClientKey(vault, "alex")).toBe("834bc60d");
  });

  it("refuses to guess among several clients when none match the vaultId", () => {
    const vault = vaultWith({ alex: { displayName: "Alex" }, blair: { displayName: "Blair" } });
    expect(() => resolveClientKey(vault, "nope")).toThrow(/"alex", "blair"/);
  });

  it("refuses an empty vault rather than resolving to nothing", () => {
    const vault = vaultWith({});
    expect(() => resolveClientKey(vault, "nope")).toThrow(/holds 0/);
  });
});
