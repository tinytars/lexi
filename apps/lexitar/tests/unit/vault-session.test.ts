// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { flushSync } from "svelte";
import { withEffectRoot, observe } from "../support/effect-root.svelte";
import { createVaultSession } from "@tinytars/frame/vault-session.svelte";

// W72 — the unlocked-session key material. docs/cross-app/10's only Phase A prerequisite, and the
// thing whose lifetime is a security property: a DEK left in memory for a vault the user believes
// they closed is a live data key with no UI acknowledging it exists.
//
// Until this module those were four separate `$state` declarations cleared in four separate
// assignments, so a half-open session was representable. These assert it no longer is.

// A class instance, not a plain object: `$state` deep-proxies plain objects and arrays but leaves
// class instances alone, and a real CryptoKey is the latter. A `{}` fixture would be proxied, fail an
// identity check for the wrong reason, and — worse — hide the question of whether the DEK handed to
// WebCrypto is the same object that was stored. The last test in this file settles that directly.
class FakeKey {}
const key = () => new FakeKey() as unknown as CryptoKey;

let cleanup: (() => void)[] = [];
afterEach(() => { for (const d of cleanup) d(); cleanup = []; });

function session() {
  const root = withEffectRoot(() => createVaultSession());
  cleanup.push(root.destroy);
  flushSync();
  return root.value;
}

describe("a vault is open, or it is not", () => {
  it("starts closed, with nothing retained", () => {
    const s = session();
    expect(s.isOpen).toBe(false);
    expect(s.dek).toBeNull();
    expect(s.r2Id).toBeNull();
  });

  it("opening sets the id and the key together", () => {
    const s = session();
    const d = key();
    s.open("data-abc", d);
    expect(s.isOpen).toBe(true);
    expect(s.r2Id).toBe("data-abc");
    expect(s.dek).toBe(d);
  });

  it("closing clears BOTH, so no data key outlives the vault it opens", () => {
    // The half-open state this module exists to make unrepresentable.
    const s = session();
    s.open("data-abc", key());
    s.close();
    expect(s.dek).toBeNull();
    expect(s.r2Id).toBeNull();
    expect(s.isOpen).toBe(false);
  });

  it("isOpen is derived, not tracked — it cannot disagree with the keys", () => {
    const s = session();
    s.open("data-abc", key());
    s.close();
    s.open("data-def", key());
    expect(s.isOpen).toBe(true);
    s.signOut();
    expect(s.isOpen).toBe(false);
  });

  it("reopening replaces the previous vault's key rather than keeping both", () => {
    const s = session();
    const first = key();
    s.open("data-abc", first);
    const second = key();
    s.open("data-def", second);
    expect(s.dek).toBe(second);
    expect(s.dek).not.toBe(first);
    expect(s.r2Id).toBe("data-def");
  });
});

describe("account keys have their own lifetime", () => {
  // A provider who leaves one patient is still signed in and still needs their own key to open the
  // next. That asymmetry was already backToRoster()'s behaviour; the test is what stops it being
  // re-derived incorrectly later.
  it("close() keeps the provider key, because the provider is still signed in", () => {
    const s = session();
    const provider = key();
    s.setProviderKey(provider);
    s.open("data-patient-1", key());
    s.close();
    expect(s.providerKey).toBe(provider);
    expect(s.dek).toBeNull();
  });

  it("signOut() clears everything, including the provider key", () => {
    const s = session();
    s.setProviderKey(key());
    s.setOwnerKey(key());
    s.open("data-abc", key());
    s.signOut();
    expect(s.dek).toBeNull();
    expect(s.r2Id).toBeNull();
    expect(s.ownerKey).toBeNull();
    expect(s.providerKey).toBeNull();
  });

  it("an owner session and a provider session do not share a slot", () => {
    const s = session();
    const owner = key();
    const provider = key();
    s.setOwnerKey(owner);
    s.setProviderKey(provider);
    expect(s.ownerKey).toBe(owner);
    expect(s.providerKey).toBe(provider);
  });
});

describe("the state is reactive, so the UI cannot render a stale lock state", () => {
  it("an effect observing isOpen re-runs when the vault opens and closes", () => {
    const seen: boolean[] = [];
    const s = session();
    cleanup.push(observe(() => s.isOpen, (v) => seen.push(v)));
    flushSync();

    s.open("data-abc", key());
    flushSync();
    s.close();
    flushSync();

    expect(seen).toEqual([false, true, false]);
  });
});

describe("the DEK survives storage unchanged", () => {
  // The subtlety that made an earlier version of these tests fail: `$state` deep-proxies plain
  // objects. If a CryptoKey were proxied, the object handed to SubtleCrypto would not be the one
  // WebCrypto issued, and `decrypt` would reject it — a failure that would surface only at runtime,
  // on a real patient's vault.
  it("stores the identical key object, not a proxy of it", () => {
    const s = session();
    const real = new FakeKey() as unknown as CryptoKey;
    s.open("data-abc", real);
    expect(s.dek).toBe(real);
    expect(Object.getPrototypeOf(s.dek as object)).toBe(FakeKey.prototype);
  });
});
