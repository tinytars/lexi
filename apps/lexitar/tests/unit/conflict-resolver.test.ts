import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConflictResolver, type ConflictResolverDeps } from "../../src/lib/conflict-resolver";
import { VaultConflictError } from "@tinytars/vault/vault-sink";
import type { Vault } from "../../src/lib/types";

function makeHarness(overrides: Partial<ConflictResolverDeps> = {}) {
  const vault: Vault = { clients: {} };
  const state = {
    vault: vault as Vault | null,
    dek: {} as CryptoKey | null,
    r2Id: "r2-1" as string | null,
    conflict: new VaultConflictError(null) as VaultConflictError | null,
    resolving: false,
  };
  const fetchVaultBlob = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const saveVault = vi.fn(async () => {});
  const decryptVault = vi.fn(async () => ({ clients: { other: {} } }) as unknown as Vault);
  const deps: ConflictResolverDeps = {
    getVault: () => state.vault,
    setVault: (v) => { state.vault = v; },
    getDek: () => state.dek,
    getR2Id: () => state.r2Id,
    getConflict: () => state.conflict,
    setConflict: (e) => { state.conflict = e; },
    getResolving: () => state.resolving,
    setResolving: (v) => { state.resolving = v; },
    fetchVaultBlob,
    saveVault,
    decryptVault,
    ...overrides,
  };
  const resolver = createConflictResolver(deps);
  return { state, deps, fetchVaultBlob, saveVault, decryptVault, resolver };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveConflictKeepMine", () => {
  it("does nothing without a vault", async () => {
    const { resolver, saveVault } = makeHarness({ getVault: () => null });
    await resolver.resolveConflictKeepMine();
    expect(saveVault).not.toHaveBeenCalled();
  });

  it("does nothing without a dek", async () => {
    const { resolver, saveVault } = makeHarness({ getDek: () => null });
    await resolver.resolveConflictKeepMine();
    expect(saveVault).not.toHaveBeenCalled();
  });

  it("does nothing without an r2Id", async () => {
    const { resolver, saveVault } = makeHarness({ getR2Id: () => null });
    await resolver.resolveConflictKeepMine();
    expect(saveVault).not.toHaveBeenCalled();
  });

  it("does nothing while already resolving — the concurrent-call guard", async () => {
    const { resolver, saveVault } = makeHarness({ getResolving: () => true });
    await resolver.resolveConflictKeepMine();
    expect(saveVault).not.toHaveBeenCalled();
  });

  it("re-fetches the blob first when the conflict carries no serverEtag", async () => {
    const { resolver, fetchVaultBlob, saveVault, state } = makeHarness({
      getConflict: () => new VaultConflictError(null),
    });
    await resolver.resolveConflictKeepMine();
    expect(fetchVaultBlob).toHaveBeenCalledTimes(1);
    expect(saveVault).toHaveBeenCalledTimes(1);
    expect(state.conflict).toBeNull();
  });

  it("skips the re-fetch when the conflict already carries a serverEtag", async () => {
    const { resolver, fetchVaultBlob, saveVault } = makeHarness({
      getConflict: () => new VaultConflictError("etag-123"),
    });
    await resolver.resolveConflictKeepMine();
    expect(fetchVaultBlob).not.toHaveBeenCalled();
    expect(saveVault).toHaveBeenCalledTimes(1);
  });

  it("clears resolving even when the save throws", async () => {
    const { resolver, state } = makeHarness({
      saveVault: vi.fn(async () => { throw new Error("network down"); }),
    });
    await resolver.resolveConflictKeepMine();
    expect(state.resolving).toBe(false);
  });

  it("replaces the conflict with a fresh VaultConflictError if the save throws one", async () => {
    const fresh = new VaultConflictError("etag-456");
    const { resolver, state } = makeHarness({
      saveVault: vi.fn(async () => { throw fresh; }),
    });
    await resolver.resolveConflictKeepMine();
    expect(state.conflict).toBe(fresh);
  });

  it("leaves the conflict unchanged when the save throws a non-conflict error", async () => {
    const setConflict = vi.fn();
    const { resolver } = makeHarness({
      getConflict: () => new VaultConflictError("etag-000"),
      setConflict,
      saveVault: vi.fn(async () => { throw new Error("network down"); }),
    });
    await resolver.resolveConflictKeepMine();
    expect(setConflict).not.toHaveBeenCalled();
  });
});

describe("resolveConflictTakeTheirs", () => {
  it("does nothing without a dek", async () => {
    const { resolver, decryptVault } = makeHarness({ getDek: () => null });
    await resolver.resolveConflictTakeTheirs();
    expect(decryptVault).not.toHaveBeenCalled();
  });

  it("does nothing without an r2Id", async () => {
    const { resolver, decryptVault } = makeHarness({ getR2Id: () => null });
    await resolver.resolveConflictTakeTheirs();
    expect(decryptVault).not.toHaveBeenCalled();
  });

  it("does nothing while already resolving", async () => {
    const { resolver, decryptVault } = makeHarness({ getResolving: () => true });
    await resolver.resolveConflictTakeTheirs();
    expect(decryptVault).not.toHaveBeenCalled();
  });

  it("fetches, decrypts, replaces the vault, and clears the conflict", async () => {
    const decrypted = { clients: { fresh: {} } } as unknown as Vault;
    const { resolver, state, fetchVaultBlob } = makeHarness({
      decryptVault: vi.fn(async () => decrypted),
    });
    await resolver.resolveConflictTakeTheirs();
    expect(fetchVaultBlob).toHaveBeenCalledTimes(1);
    expect(state.vault).toBe(decrypted);
    expect(state.conflict).toBeNull();
  });

  it("clears resolving even when decrypt throws", async () => {
    const { resolver, state } = makeHarness({
      decryptVault: vi.fn(async () => { throw new Error("bad key"); }),
    });
    await expect(resolver.resolveConflictTakeTheirs()).rejects.toThrow("bad key");
    expect(state.resolving).toBe(false);
  });
});
