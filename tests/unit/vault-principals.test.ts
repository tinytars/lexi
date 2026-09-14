import { describe, it, expect, vi, beforeEach } from "vitest";

// W76 — the first unit tests for the access panel and the vault re-key.
//
// The re-key was written in W75 and shipped on an e2e alone. An e2e cannot interrupt it: Playwright
// drives the button and sees the finished DOM, so the one property the W75 fix exists for — that a
// connection dropped between the blob write and the envelope commit leaves the vault openable —
// had no test at all. That property is the first describe block below.

const auth = vi.hoisted(() => ({
  listMyProviders: vi.fn(),
  lookupProvider: vi.fn(),
  grantProvider: vi.fn(),
  revokeProvider: vi.fn(),
  approveSupport: vi.fn(),
  approveSupportAsProvider: vi.fn(),
  getVaultPrincipals: vi.fn(),
  stageVaultRotation: vi.fn(),
  rotateVault: vi.fn(),
}));
vi.mock("@tinytars/vault/auth-grants", () => ({
  listMyProviders: auth.listMyProviders,
  lookupProvider: auth.lookupProvider,
  grantProvider: auth.grantProvider,
  revokeProvider: auth.revokeProvider,
}));
vi.mock("@tinytars/vault/auth-support", () => ({
  approveSupport: auth.approveSupport,
  approveSupportAsProvider: auth.approveSupportAsProvider,
}));
vi.mock("@tinytars/vault/auth-recovery", () => ({
  getVaultPrincipals: auth.getVaultPrincipals,
  stageVaultRotation: auth.stageVaultRotation,
  rotateVault: auth.rotateVault,
}));
vi.mock("@tinytars/vault/crypto", () => ({
  generateDEK: vi.fn(async () => ({ id: "dek-new" }) as unknown as CryptoKey),
  wrapDEKForPublicKey: vi.fn(async (dek: { id: string }, jwk: JsonWebKey) => ({
    wrappedDEK: new TextEncoder().encode(`${dek.id}->${(jwk as { kid?: string }).kid}`),
    ephemeralPublicKeyJwk: { kid: "eph" } as JsonWebKey,
  })),
}));

import { createVaultPrincipals } from "@tinytars/frame/vault-principals.svelte";
import { createVaultSession } from "@tinytars/frame/vault-session.svelte";
import type { Vault } from "../../src/lib/types";
import type { ProviderLinkView } from "@tinytars/vault/auth-grants";

const OLD_DEK = { id: "dek-old" } as unknown as CryptoKey;
const VAULT = { clients: {} } as unknown as Vault;

/**
 * A stand-in for the two things the server keeps: the R2 object each id holds, and the envelope rows
 * that say which key opens which vault. "Openable" below means exactly what it means in production —
 * the envelopes name the id whose blob was encrypted under the key they wrap.
 */
function fakeStore() {
  const blobs = new Map<string, string>([["vault-1", "dek-old"]]);
  let pointer = "vault-1";
  let envelopes = [
    { principalAccountId: "self", wrappedDEK: "dek-old->self" },
    { principalAccountId: "org", wrappedDEK: "dek-old->org" },
  ];
  return {
    blobs,
    get pointer() {
      return pointer;
    },
    get envelopes() {
      return envelopes;
    },
    commit(newVaultId: string, next: { principalAccountId: string; wrappedDEK: string }[]) {
      pointer = newVaultId;
      // The controller base64s what the wrapper returned; decode so the assertion below can read it.
      envelopes = next.map((e) => ({ ...e, wrappedDEK: atob(e.wrappedDEK) }));
    },
    /** The invariant: every envelope wraps the key the pointed-at blob is encrypted under. */
    opens(): boolean {
      const key = blobs.get(pointer);
      return !!key && envelopes.length > 0 && envelopes.every((e) => e.wrappedDEK.startsWith(`${key}->`));
    },
  };
}

let store: ReturnType<typeof fakeStore>;

function makeController(over: { orgRecoveryRevokedAt?: string | null; providers?: { accountId: string; publicKeyJwk: JsonWebKey }[] } = {}) {
  const session = createVaultSession();
  session.open("vault-1", OLD_DEK);
  const errors: (string | null)[] = [];
  const c = createVaultPrincipals({
    getVault: () => VAULT,
    session,
    saveVault: async (_v, id, dek) => {
      store.blobs.set(id, (dek as unknown as { id: string }).id);
    },
    reportError: (m) => errors.push(m),
  });
  auth.getVaultPrincipals.mockResolvedValue({
    selfAccountId: "self",
    orgAccountId: "org",
    selfPublicKeyJwk: { kid: "self" },
    orgPublicKeyJwk: { kid: "org" },
    providers: over.providers ?? [],
    envelopePrincipalIds: ["self", "org"],
    orgRecoveryRevokedAt: over.orgRecoveryRevokedAt ?? null,
    vaultId: "vault-1",
  });
  return { c, session, errors };
}

const link = (over: Partial<ProviderLinkView> = {}): ProviderLinkView =>
  ({ linkId: "l1", displayName: "Dr Who", kind: "primary", status: "active", ...over }) as ProviderLinkView;

beforeEach(() => {
  vi.clearAllMocks();
  store = fakeStore();
  auth.listMyProviders.mockResolvedValue([]);
  auth.stageVaultRotation.mockImplementation(async () => "vault-2");
  auth.rotateVault.mockImplementation(async (a: { newVaultId: string; envelopes: { principalAccountId: string; wrappedDEK: string }[] }) =>
    store.commit(a.newVaultId, a.envelopes),
  );
});

describe("the re-key is atomic: an interruption never strands the vault", () => {
  it("leaves the old blob and the old envelopes agreeing when the commit never lands", async () => {
    auth.rotateVault.mockRejectedValue(new Error("connection dropped"));
    const { c, session } = makeController();

    await expect(c.rotateVaultKey()).rejects.toThrow("connection dropped");

    // The new ciphertext exists, under a key only this tab ever held — and nothing points at it.
    expect(store.blobs.get("vault-2")).toBe("dek-new");
    expect(store.pointer).toBe("vault-1");
    expect(store.opens()).toBe(true);
    // The session must not have moved either, or the tab would read a vault the server has not adopted.
    expect(session.r2Id).toBe("vault-1");
  });

  it("writes the re-encrypted blob to a NEW id — never over the one still in use", async () => {
    const { c } = makeController();
    await c.rotateVaultKey();

    expect(auth.stageVaultRotation).toHaveBeenCalledWith("vault-1");
    // The pre-rotation ciphertext survives the whole operation; the commit is a pointer swap.
    expect(store.blobs.get("vault-1")).toBe("dek-old");
    expect(store.pointer).toBe("vault-2");
    expect(store.opens()).toBe(true);
  });

  it("stages before it writes, and commits only after every envelope is wrapped", async () => {
    const order: string[] = [];
    auth.stageVaultRotation.mockImplementation(async () => (order.push("stage"), "vault-2"));
    auth.rotateVault.mockImplementation(async () => void order.push("commit"));
    const { c } = makeController();

    await c.rotateVaultKey();
    expect(order).toEqual(["stage", "commit"]);
  });

  it("re-wraps to the owner, org recovery and every active provider", async () => {
    const { c } = makeController({ providers: [{ accountId: "p1", publicKeyJwk: { kid: "p1" } as JsonWebKey }] });
    await c.rotateVaultKey();

    expect(store.envelopes.map((e) => e.principalAccountId).sort()).toEqual(["org", "p1", "self"]);
    expect(store.opens()).toBe(true);
  });

  it("does not silently restore org recovery for a patient who removed it", async () => {
    const { c } = makeController({ orgRecoveryRevokedAt: "2026-01-01T00:00:00Z" });
    await c.rotateVaultKey();

    expect(store.envelopes.map((e) => e.principalAccountId)).toEqual(["self"]);
  });

  it("opens the session on the new id and the new key, together", async () => {
    const { c, session } = makeController();
    await c.rotateVaultKey();

    expect(session.r2Id).toBe("vault-2");
    expect((session.dek as unknown as { id: string }).id).toBe("dek-new");
  });

  it("does nothing at all without an open vault", async () => {
    const session = createVaultSession(); // never opened
    const c = createVaultPrincipals({
      getVault: () => VAULT,
      session,
      saveVault: async () => {},
      reportError: () => {},
    });
    await c.rotateVaultKey();
    expect(auth.stageVaultRotation).not.toHaveBeenCalled();
  });
});

describe("revoking support re-keys; revoking a clinician does not", () => {
  it("re-keys when an ACTIVE support agent is revoked — they may have cached the DEK", async () => {
    const { c } = makeController();
    await c.revoke(link({ kind: "support", status: "active" }));
    expect(auth.stageVaultRotation).toHaveBeenCalled();
    expect(store.pointer).toBe("vault-2");
  });

  it("does not re-key when denying a support request that was never approved", async () => {
    const { c } = makeController();
    await c.revoke(link({ kind: "support", status: "invited" }));
    expect(auth.revokeProvider).toHaveBeenCalledWith("l1");
    expect(auth.stageVaultRotation).not.toHaveBeenCalled();
  });

  it("does not re-key when a clinician is revoked — delete-only, by design", async () => {
    const { c } = makeController();
    await c.revoke(link({ kind: "primary", status: "active" }));
    expect(auth.stageVaultRotation).not.toHaveBeenCalled();
  });

  it("surfaces a failed revoke on the panel and clears busy", async () => {
    auth.revokeProvider.mockRejectedValue(new Error("gone"));
    const { c } = makeController();
    await c.revoke(link());
    expect(c.error).toBe("gone");
    expect(c.busy).toBe(false);
  });
});

describe("adding a provider", () => {
  it("grants with the in-memory DEK and clears the input", async () => {
    auth.lookupProvider.mockResolvedValue({ accountId: "p1", publicKeyJwk: { kid: "p1" } });
    const { c } = makeController();
    c.newProviderEmail = "  dr@example.com  ";

    await c.addProvider();

    expect(auth.lookupProvider).toHaveBeenCalledWith("dr@example.com");
    expect(auth.grantProvider).toHaveBeenCalledWith(OLD_DEK, { accountId: "p1", publicKeyJwk: { kid: "p1" } });
    expect(c.newProviderEmail).toBe("");
  });

  it("reports an unknown email without granting, and without a pointless reload", async () => {
    auth.lookupProvider.mockResolvedValue(null);
    const { c } = makeController();
    c.newProviderEmail = "nobody@example.com";

    await c.addProvider();

    expect(c.error).toBe("No provider found with that email.");
    expect(auth.grantProvider).not.toHaveBeenCalled();
    expect(auth.listMyProviders).not.toHaveBeenCalled();
    expect(c.busy).toBe(false);
  });

  it("does nothing without a DEK — a grant needs the key it is wrapping", async () => {
    const session = createVaultSession();
    const c = createVaultPrincipals({ getVault: () => VAULT, session, saveVault: async () => {}, reportError: () => {} });
    c.newProviderEmail = "dr@example.com";
    await c.addProvider();
    expect(auth.lookupProvider).not.toHaveBeenCalled();
  });
});

describe("the panel's own state", () => {
  it("loads the list on open and keeps the error visible when it fails", async () => {
    auth.listMyProviders.mockRejectedValue(new Error("offline"));
    const { c } = makeController();
    await c.openPanel();
    expect(c.open).toBe(true);
    expect(c.error).toBe("offline");
  });

  it("partitions the list the three ways the two consoles render", async () => {
    auth.listMyProviders.mockResolvedValue([
      link({ linkId: "a", kind: "support", status: "invited" }),
      link({ linkId: "b", kind: "support", status: "active" }),
      link({ linkId: "c", kind: "primary", status: "active" }),
    ]);
    const { c } = makeController();
    await c.openPanel();

    expect(c.pendingSupport.map((p) => p.linkId)).toEqual(["a"]);
    expect(c.activeSupport.map((p) => p.linkId)).toEqual(["b"]);
    expect(c.activeAccess.map((p) => p.linkId)).toEqual(["b", "c"]);
  });

  it("a quiet refresh never throws — an empty section beats a blocked boot", async () => {
    auth.listMyProviders.mockRejectedValue(new Error("offline"));
    const { c } = makeController();
    await expect(c.refreshQuietly()).resolves.toBeUndefined();
    expect(c.error).toBeNull();
  });

  it("reset clears the list and the typed email, not just the open flag", async () => {
    auth.listMyProviders.mockResolvedValue([link()]);
    const { c } = makeController();
    await c.openPanel();
    c.newProviderEmail = "half@typed.com";

    c.reset();

    expect(c.open).toBe(false);
    expect(c.providers).toEqual([]);
    expect(c.newProviderEmail).toBe("");
  });
});

describe("the provider-side pair reports through the shared error line", () => {
  it("approves a roster request with the chosen TTL", async () => {
    const { c, errors } = makeController();
    c.ttlHours = 24;
    await c.approveAsProvider(link({ kind: "support", status: "invited" }));

    expect(auth.approveSupportAsProvider).toHaveBeenCalledWith("l1", 24);
    expect(errors).toContain(null); // cleared on entry
  });

  it("routes its failure to the host, not to the panel that is not mounted there", async () => {
    auth.revokeProvider.mockRejectedValue(new Error("nope"));
    const { c, errors } = makeController();
    await c.revokeAsProvider(link({ kind: "support", status: "active" }));

    expect(errors).toContain("nope");
    expect(c.error).toBeNull();
  });

  it("never re-keys — a provider owns nothing encrypted", async () => {
    const { c } = makeController();
    await c.revokeAsProvider(link({ kind: "support", status: "active" }));
    expect(auth.stageVaultRotation).not.toHaveBeenCalled();
  });
});
