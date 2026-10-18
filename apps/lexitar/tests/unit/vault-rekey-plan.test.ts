// The refusals a DEK rotation makes before it writes anything (src/lib/vault-rekey-plan.ts).
//
// Worth testing because every one of them is a failure that succeeds: a rotation that wraps a fresh
// DEK to a published public key completes, verifies, prints a tick and leaves the vault exactly as
// readable as it was — and nothing about the vault afterwards says so. The compromised-key case is
// pinned against the real recorded thumbprints rather than invented ones, so a drift in
// scripts/compromised-public-keys.json breaks this suite instead of quietly disarming the refusal.
import { describe, it, expect } from "vitest";
import {
  refuseRekey,
  describeRefusal,
  rekeyScope,
  blocksAfterReplacement,
  parseRekeyArgs,
  stemOf,
  type Principal,
  type CompromisedKey,
} from "../../src/lib/vault-rekey-plan";
import compromisedFile from "../../scripts/compromised-public-keys.json";

const COMPROMISED = compromisedFile.keys as CompromisedKey[];
const ORG = "00000000-0000-4000-8000-000000000001";
const ORG_THUMBPRINT = COMPROMISED.find((c) => c.accountId === ORG)!.thumbprint;

const JWK: JsonWebKey = { kty: "EC", crv: "P-256", x: "x", y: "y" };
const p = (accountId: string, thumbprint: string): Principal => ({ accountId, publicKeyJwk: JWK, thumbprint });

/** The shape of a clean rotation: the org principal plus an owner, both on uncompromised keys. */
const clean = (): Principal[] => [p(ORG, "fresh-org-thumbprint"), p("owner-1", "fresh-owner-thumbprint")];

describe("refuseRekey", () => {
  it("permits a rotation whose principals all hold keys that were never published", () => {
    expect(refuseRekey(clean(), COMPROMISED, ORG, false, null)).toEqual([]);
  });

  it("refuses a principal still holding a published public key, and names the role", () => {
    const published = COMPROMISED.find((c) => c.role === "provider")!;
    const refusals = refuseRekey(
      [p(ORG, "fresh-org-thumbprint"), p(published.accountId, published.thumbprint)],
      COMPROMISED,
      ORG,
      false,
      null,
    );
    expect(refusals).toEqual([
      { kind: "compromised-key", accountId: published.accountId, thumbprint: published.thumbprint, role: "provider" },
    ]);
  });

  it("refuses the ORG principal on its published key too — it is not exempt from its own rule", () => {
    // The org key is the one whose private half is wrapped under an unpassphrased secret rather than
    // a printed slug, which is the asymmetry the whole remediation turns on. It is still published.
    const refusals = refuseRekey([p(ORG, ORG_THUMBPRINT)], COMPROMISED, ORG, false, null);
    expect(refusals).toEqual([{ kind: "compromised-key", accountId: ORG, thumbprint: ORG_THUMBPRINT, role: "org operational" }]);
  });

  it("matches on the thumbprint and not on the account id, so a re-keyed account passes", () => {
    const published = COMPROMISED.find((c) => c.role === "published owner")!;
    // Same account, new keypair: this is precisely the state Phase 3(d) leaves behind, and the
    // rotation must proceed. An accountId-keyed refusal would deadlock the plan at this point.
    expect(refuseRekey([p(ORG, "fresh-org"), p(published.accountId, "a-new-thumbprint")], COMPROMISED, ORG, false, null)).toEqual([]);
  });

  it("refuses an empty principal set rather than minting a DEK nobody holds", () => {
    expect(refuseRekey([], COMPROMISED, ORG, false, null)).toEqual([{ kind: "no-principals" }]);
  });

  it("does not also claim a missing org envelope when there are no principals at all", () => {
    // One cause, one refusal: a report listing both reads as two problems and sends the operator
    // looking for a second one that does not exist.
    expect(refuseRekey([], COMPROMISED, ORG, false, null)).toHaveLength(1);
  });

  it("refuses a principal set the org holds no envelope on", () => {
    expect(refuseRekey([p("owner-1", "fresh")], COMPROMISED, ORG, false, null)).toEqual([
      { kind: "missing-org-envelope" },
    ]);
  });

  it("refuses a duplicated principal, which an INSERT per row would silently collapse", () => {
    const dup = [...clean(), p("owner-1", "fresh-owner-thumbprint")];
    expect(refuseRekey(dup, COMPROMISED, ORG, false, null)).toEqual([
      { kind: "duplicate-principal", accountId: "owner-1" },
    ]);
  });

  it("refuses while a rotation is already pending, and carries the staged key into the report", () => {
    expect(refuseRekey(clean(), COMPROMISED, ORG, true, "data-staged.enc")).toEqual([
      { kind: "rotation-pending", stagingKey: "data-staged.enc" },
    ]);
  });

  it("reports every refusal in one pass rather than stopping at the first", () => {
    // The operator fixes these by hand, out of band, one account at a time. A report that reveals
    // the second problem only after the first is fixed costs a whole sitting per refusal.
    const published = COMPROMISED.filter((c) => c.role === "published owner");
    const refusals = refuseRekey(
      published.map((c) => p(c.accountId, c.thumbprint)),
      COMPROMISED,
      ORG,
      true,
      null,
    );
    expect(refusals.map((r) => r.kind).sort()).toEqual([
      "compromised-key",
      "compromised-key",
      "missing-org-envelope",
      "rotation-pending",
    ]);
  });

  it("treats a thumbprint as opaque — no normalization, no case folding", () => {
    // RFC 7638 thumbprints are base64url, where case is significant. Folding it would make two
    // distinct keys compare equal, and the direction that matters is the unsafe one: a published
    // key passing because its recorded thumbprint differs only in case.
    const published = COMPROMISED.find((c) => c.accountId !== ORG && c.thumbprint !== c.thumbprint.toLowerCase())!;
    expect(
      refuseRekey([p(ORG, "fresh"), p(published.accountId, published.thumbprint.toLowerCase())], COMPROMISED, ORG, false, null),
    ).toEqual([]);
    expect(published.thumbprint).not.toEqual(published.thumbprint.toLowerCase());
  });
});

describe("rekeyScope", () => {
  // Measured on dev: one of six vaults holds a single principal, `d59c9b0c`, whose key was never
  // published — and it holds no org envelope either, which is why `clean()` is not this fixture.
  const outOfScope = (): Principal[] => [p("d59c9b0c-never-published", "fresh-owner-thumbprint")];

  it("is empty for a vault holding no principal whose key was published — work nobody has to do", () => {
    // Before this existed the report called it blocked, which reads as a keypair to go and replace.
    expect(rekeyScope(outOfScope(), COMPROMISED)).toEqual([]);
  });

  it("names every published principal a vault holds, so the report can say which", () => {
    const owner = COMPROMISED.find((c) => c.role === "published owner")!;
    const scope = rekeyScope([p(ORG, ORG_THUMBPRINT), p(owner.accountId, owner.thumbprint), p("x", "fresh")], COMPROMISED);
    expect(scope.map((c) => c.role).sort()).toEqual(["org operational", "published owner"]);
  });

  it("counts the org principal, whose envelope has to be re-minted either way", () => {
    // The org private half is passphrase-wrapped and was never published, so an org-only vault is
    // not openable from a clone. It is still in scope: the org keypair is being replaced, and every
    // envelope minted to the old one stops being usable when it is.
    expect(rekeyScope([p(ORG, ORG_THUMBPRINT), p("owner", "fresh")], COMPROMISED)).toHaveLength(1);
  });

  // THE ORDERING REGRESSION. This is the one test in this file that pins a bug that existed rather
  // than a mistake that was anticipated: scope was keyed by thumbprint, like the refusals, and the
  // remediation runs keypair-replacement BEFORE the DEK rotation — so by the time the rotation ran,
  // no live thumbprint matched and every vault reported "needs nothing" while every envelope on it
  // was still openable by a published private key. A refusal would have been survivable. A vault
  // reported as needing nothing is not: nothing downstream looks at it again.
  it("still scopes a vault in after the principal's keypair has been replaced", () => {
    const owner = COMPROMISED.find((c) => c.accountId !== ORG)!;
    const replaced = [p(ORG, "fresh-org-thumbprint"), p(owner.accountId, "a-brand-new-thumbprint")];

    expect(rekeyScope(replaced, COMPROMISED)).toHaveLength(2);
    // And the refusals, asked at the same moment, are empty — which is the whole point of the two
    // being keyed differently. Scope says there is work; refuseRekey says nothing blocks it.
    expect(refuseRekey(replaced, COMPROMISED, ORG, false, null)).toEqual([]);
  });

  it("is keyed by account id, so a vault is scoped by who holds an envelope and not by a key value", () => {
    const owner = COMPROMISED.find((c) => c.accountId !== ORG)!;
    // Same thumbprint, a different account: that account never had a published key, so a vault of
    // its own is out of scope even though the key value appears in the record.
    expect(rekeyScope([p("some-other-account", owner.thumbprint)], COMPROMISED)).toEqual([]);
  });
});

describe("blocksAfterReplacement", () => {
  // The question replace-keypair asks BEFORE it replaces anything, which is why the one refusal it
  // has to ignore is the one that is always there at that moment.
  it("drops compromised-key, because that is the condition the replacement is about to remove", () => {
    const published = COMPROMISED.find((c) => c.accountId !== ORG)!;
    const refusals = refuseRekey(
      [p(ORG, "fresh-org-thumbprint"), p(published.accountId, published.thumbprint)],
      COMPROMISED,
      ORG,
      false,
      null,
    );
    expect(refusals.map((r) => r.kind)).toEqual(["compromised-key"]);
    expect(blocksAfterReplacement(refusals)).toEqual([]);
  });

  it("keeps every arm a new keypair does not make false", () => {
    const refusals = refuseRekey([], COMPROMISED, ORG, true, "data-x.enc");
    expect(blocksAfterReplacement(refusals).map((r) => r.kind).sort()).toEqual(["no-principals", "rotation-pending"]);
  });

  it("keeps missing-org-envelope, which is the one measured on dev and the one that blocks", () => {
    const refusals = refuseRekey([p("owner", "fresh")], COMPROMISED, ORG, false, null);
    expect(blocksAfterReplacement(refusals)).toEqual([{ kind: "missing-org-envelope" }]);
  });
});

describe("describeRefusal", () => {
  it("tells the operator what to do next, not only what is wrong", () => {
    const text = describeRefusal({ kind: "compromised-key", accountId: "a", thumbprint: "t", role: "provider" });
    expect(text).toContain("PUBLISHED");
    expect(text).toContain("Replace this account's keypair first");
  });

  it("names the staged object when there is one and stays readable when there is not", () => {
    expect(describeRefusal({ kind: "rotation-pending", stagingKey: "data-x.enc" })).toContain("data-x.enc");
    expect(describeRefusal({ kind: "rotation-pending", stagingKey: null })).not.toContain("staged at");
  });

  it("has a sentence for every arm of the union", () => {
    // Not a tautology: the union is exhaustive-checked by tsc, but a `default` added later would
    // compile fine and return undefined for a new arm, which prints "undefined" to an operator.
    const all = [
      { kind: "no-principals" },
      { kind: "compromised-key", accountId: "a", thumbprint: "t", role: "r" },
      { kind: "duplicate-principal", accountId: "a" },
      { kind: "missing-org-envelope" },
      { kind: "rotation-pending", stagingKey: null },
    ] as const;
    for (const r of all) expect(describeRefusal(r)).toMatch(/[a-z]{4}/);
  });
});

describe("parseRekeyArgs", () => {
  it("defaults to --check: no apply, no selector, nothing written", () => {
    expect(parseRekeyArgs([])).toEqual({ apply: false, all: false, vaultIds: [] });
  });

  it("collects repeated --vault selectors and lowercases them, as the D1 ids are stored", () => {
    expect(parseRekeyArgs(["--vault", "AAA", "--vault", "bbb"]).vaultIds).toEqual(["aaa", "bbb"]);
  });

  it("refuses --apply with no selector rather than defaulting to every vault", () => {
    expect(() => parseRekeyArgs(["--apply"])).toThrow(/needs --vault/);
  });

  it("refuses --all together with --vault, which reads as a narrowing and is not one", () => {
    expect(() => parseRekeyArgs(["--all", "--vault", "x"])).toThrow(/mutually exclusive/);
  });

  it("accepts --apply --all and --apply --vault", () => {
    expect(parseRekeyArgs(["--apply", "--all"])).toEqual({ apply: true, all: true, vaultIds: [] });
    expect(parseRekeyArgs(["--apply", "--vault", "x"])).toEqual({ apply: true, all: false, vaultIds: ["x"] });
  });
});

describe("stemOf", () => {
  it("reads the id out of a bare object name and out of a store-prefixed key", () => {
    expect(stemOf("data-abc.enc")).toBe("abc");
    expect(stemOf("dev/data-abc.enc")).toBe("abc");
    expect(stemOf("prod/stores/dev/data-abc.enc")).toBe("abc");
  });

  it("lowercases, because org-unwrap.ts refuses an id outside /^[a-z0-9-]+$/", () => {
    expect(stemOf("data-7DE3DFED-C872-4971-A923-C85D3322C087.enc")).toBe("7de3dfed-c872-4971-a923-c85d3322c087");
  });

  it("throws on a key it cannot read rather than returning something plausible", () => {
    // A silent fallback here would key the audit row — and therefore the org-key use record — to the
    // wrong vault, which is the one thing VAULT.md §2 makes the operator read conditional on.
    for (const bad of ["", "data-abc", "abc.enc", "data-.enc"]) expect(() => stemOf(bad)).toThrow(/cannot read a vault id/);
  });
});
