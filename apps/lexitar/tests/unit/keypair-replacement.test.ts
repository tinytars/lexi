// The decisions a keypair replacement makes before it writes anything (src/lib/keypair-replacement.ts).
//
// Every refusal pinned here is a way for the command to report success and still have locked
// somebody out of their own record permanently. The classifier's cases are pinned against the four
// kdf_params shapes measured live on dev rather than invented ones, so a method whose parameters
// change breaks this suite instead of being silently mis-handled.
import { describe, it, expect } from "vitest";
import {
  classifyCredential,
  refuseReplace,
  describeReplaceRefusal,
  parseReplaceArgs,
  type CredentialRow,
  type ReplaceRefusal,
} from "../../src/lib/keypair-replacement";

// Verbatim shapes, read off dev's `credentials` table. Salt values are placeholders; the structure
// is what is under test and the structure is what was measured.
const PASSWORD: CredentialRow = {
  method: "password",
  kdfParams: '{"salt":"00112233445566778899aabbccddeeff","iterations":200000,"authHashSha256":"zz"}',
};
const RECOVERY: CredentialRow = {
  method: "recovery",
  kdfParams: '{"salt":"ffeeddccbbaa99887766554433221100","iterations":200000,"authHashSha256":"yy"}',
};
const GOOGLE: CredentialRow = { method: "google", kdfParams: '{"kek":"google-hkdf-v1"}' };
const PASSKEY: CredentialRow = {
  method: "passkey",
  kdfParams: '{"prfSalt":"aa","credentialID":"bb","credentialPublicKey":"cc","counter":0,"transports":["internal"]}',
};

const ok = (over: Partial<Parameters<typeof refuseReplace>[0]> = {}) =>
  refuseReplace({
    liveThumbprint: "published-thumbprint",
    compromisedThumbprint: "published-thumbprint",
    credentials: [PASSWORD, RECOVERY, GOOGLE, PASSKEY],
    hasPasswordIdentity: true,
    vaults: [{ vaultId: "v1", rotatable: true }],
    ...over,
  });

describe("classifyCredential", () => {
  it("re-wraps a PBKDF2 credential, because a new secret re-derives its KEK offline", () => {
    expect(classifyCredential(PASSWORD)).toEqual({ method: "password", fate: "rewrap" });
    expect(classifyCredential(RECOVERY)).toEqual({ method: "recovery", fate: "rewrap" });
  });

  it("drops a passkey and says the KEK is on a device, not that the method is unsupported", () => {
    const f = classifyCredential(PASSKEY);
    expect(f.fate).toBe("drop");
    expect(f.fate === "drop" && f.why).toContain("authenticator");
  });

  it("drops a federated credential and names the flow its KEK comes from", () => {
    const f = classifyCredential(GOOGLE);
    expect(f.fate === "drop" && f.why).toContain("google-hkdf-v1");
  });

  // The point of classifying by parameters rather than by name: a method nobody here has heard of
  // is handled, conservatively, instead of falling through a switch as if it were a password.
  it("drops an unknown method rather than assuming it is re-wrappable", () => {
    expect(classifyCredential({ method: "future-thing", kdfParams: '{"something":"else"}' }).fate).toBe("drop");
  });

  it("drops a row whose parameters do not parse, instead of throwing and stranding the account", () => {
    // Refusing the whole account over one malformed row would leave the PUBLISHED keypair in
    // service, which is worse than the holder re-registering one method.
    const f = classifyCredential({ method: "password", kdfParams: "not json" });
    expect(f.fate).toBe("drop");
    expect(f.fate === "drop" && f.why).toContain("not JSON");
  });

  it("does not take a bare iteration count or a bare salt for a PBKDF2 block", () => {
    expect(classifyCredential({ method: "x", kdfParams: '{"salt":"aa"}' }).fate).toBe("drop");
    expect(classifyCredential({ method: "x", kdfParams: '{"iterations":200000}' }).fate).toBe("drop");
    expect(classifyCredential({ method: "x", kdfParams: '{"salt":"aa","iterations":"200000"}' }).fate).toBe("drop");
  });
});

describe("refuseReplace", () => {
  it("permits the replacement measured on dev: four methods, two re-wrappable, one rotatable vault", () => {
    expect(ok()).toEqual([]);
  });

  it("refuses an account whose key is already new, which is what makes a second run harmless", () => {
    const r = ok({ liveThumbprint: "a-new-thumbprint" });
    expect(r).toEqual([{ kind: "key-already-replaced", thumbprint: "a-new-thumbprint" }]);
  });

  it("refuses an account with no public_keys row at all", () => {
    expect(ok({ liveThumbprint: null })).toEqual([{ kind: "no-public-key" }]);
  });

  it("refuses an account with no credentials, which a new keypair would wrap under nothing", () => {
    expect(ok({ credentials: [] })).toEqual([{ kind: "no-credentials" }]);
  });

  // The arm that distinguishes a rotation from an account deletion.
  it("refuses an account whose every method is a drop, rather than deleting every way in", () => {
    const r = ok({ credentials: [GOOGLE, PASSKEY] });
    expect(r).toEqual([{ kind: "nothing-re-wrappable", methods: ["google", "passkey"] }]);
  });

  it("refuses an account the sign-in route would never offer a password to", () => {
    expect(ok({ hasPasswordIdentity: false })).toEqual([{ kind: "no-password-identity" }]);
  });

  // THE PHASE ORDERING, as a refusal rather than as a sentence in a plan. Measured on dev: vault
  // `8dafade9` holds an envelope for a published owner and carries NO org envelope, so the DEK
  // rotation refuses it. Replacing that owner's keypair anyway leaves the vault unreadable by its
  // principal and still openable by the published private key.
  it("refuses an account holding an envelope on a vault the DEK rotation will not take", () => {
    const r = ok({ vaults: [{ vaultId: "v1", rotatable: true }, { vaultId: "8dafade9", rotatable: { why: "no org envelope" } }] });
    expect(r).toEqual([{ kind: "vault-not-rotatable", vaultId: "8dafade9", why: "no org envelope" }]);
  });

  it("names every un-rotatable vault, not the first — the operator fixes these one at a time", () => {
    const r = ok({ vaults: [{ vaultId: "a", rotatable: { why: "x" } }, { vaultId: "b", rotatable: { why: "y" } }] });
    expect(r.map((x) => x.kind === "vault-not-rotatable" && x.vaultId)).toEqual(["a", "b"]);
  });

  it("permits an account on no vault at all — there is no envelope to strand", () => {
    expect(ok({ vaults: [] })).toEqual([]);
  });

  it("reports every cause in one pass, so the operator sees the whole job", () => {
    const r = refuseReplace({
      liveThumbprint: null,
      compromisedThumbprint: "published-thumbprint",
      credentials: [GOOGLE],
      hasPasswordIdentity: false,
      vaults: [{ vaultId: "v", rotatable: { why: "rotation pending" } }],
    });
    expect(r.map((x) => x.kind).sort()).toEqual([
      "no-password-identity",
      "no-public-key",
      "nothing-re-wrappable",
      "vault-not-rotatable",
    ]);
  });
});

describe("describeReplaceRefusal", () => {
  it("tells the operator what to do next, not only what is wrong", () => {
    expect(describeReplaceRefusal({ kind: "nothing-re-wrappable", methods: ["google"] })).toContain("re-register in the app");
  });

  it("states both halves of the ordering hazard, because only one of them is obvious", () => {
    const t = describeReplaceRefusal({ kind: "vault-not-rotatable", vaultId: "v", why: "no org envelope" });
    expect(t).toContain("unreadable by its principal");
    expect(t).toContain("still openable by the published key");
  });

  it("has a sentence for every arm", () => {
    // Annotated rather than `as const`: the annotation is what makes TypeScript check each literal
    // against the union, so an arm added to ReplaceRefusal with a shape this list does not satisfy
    // breaks here. `as const` typed the literals as themselves and checked nothing — and its
    // `readonly []` was rejected by svelte-check's app tsconfig while `tsc -p tsconfig.node.json`
    // passed, which is why the gate for this tree is `npm run check` and not either half of it.
    const all: ReplaceRefusal[] = [
      { kind: "key-already-replaced", thumbprint: "t" },
      { kind: "no-public-key" },
      { kind: "no-credentials" },
      { kind: "nothing-re-wrappable", methods: [] },
      { kind: "no-password-identity" },
      { kind: "vault-not-rotatable", vaultId: "v", why: "w" },
    ];
    for (const r of all) expect(describeReplaceRefusal(r).length).toBeGreaterThan(20);
  });
});

describe("parseReplaceArgs", () => {
  it("defaults to a report that writes nothing", () => {
    expect(parseReplaceArgs([])).toEqual({ apply: false, all: false, org: false, accountIds: [] });
  });

  it("refuses --apply with no selector rather than replacing every keypair in the store", () => {
    expect(() => parseReplaceArgs(["--apply"])).toThrow(/will not guess/);
  });

  it("takes --account more than once, and lowercases it so a pasted uuid matches", () => {
    expect(parseReplaceArgs(["--apply", "--account", "AB-1", "--account", "cd-2"]).accountIds).toEqual(["ab-1", "cd-2"]);
  });

  it("refuses --all beside --account, which would silently widen a named run", () => {
    expect(() => parseReplaceArgs(["--apply", "--all", "--account", "a"])).toThrow(/mutually exclusive/);
  });

  it("accepts --org on its own, because the org's new key comes from a file rather than being minted", () => {
    expect(parseReplaceArgs(["--apply", "--org"])).toEqual({ apply: true, all: false, org: true, accountIds: [] });
  });
});
