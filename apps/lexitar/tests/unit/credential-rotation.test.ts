import { describe, it, expect } from "vitest";
import {
  weakCandidates,
  matchesSelector,
  parseRotateArgs,
  suppliedAppliesTo,
  rotationVerdict,
  type RotationOutcome,
} from "../../src/lib/credential-rotation";

// W76 — the first tests over `npm run vault:rotate`'s decisions.
//
// This is the one command in the repo whose partial failure is unrecoverable: the password is the
// KEK over the account private key, which is the only thing that unwraps the vault DEK, so a
// rotation that half-lands takes a person's record away permanently. Nothing here touches D1 or R2 —
// those are the shell. What is asserted is what the shell is told to do, and when it must refuse.

const row = { accountId: "acct-blair", email: "blair@local.invalid", displayName: "Blair" };

describe("the values this repo itself documented", () => {
  it("offers the email local part and the display name, deduplicated", () => {
    expect(weakCandidates({ email: "alex@local.invalid", displayName: "Alex" })).toEqual(["alex"]);
    expect(weakCandidates(row)).toEqual(["blair"]);
    expect(weakCandidates({ email: "blair@local.invalid", displayName: "Dr. Reyes" })).toEqual(["blair", "dr. reyes"]);
  });

  it("prefixes recovery codes, because a recovery code wraps the same private key", () => {
    // If this returned the bare slug for --method recovery, an audit would report "ok" over the very
    // `recover-blair` values AUTH.md tabulates, and the hole would stay exactly where it was.
    expect(weakCandidates(row, "recovery")).toEqual(["recover-blair"]);
  });

  it("has nothing to offer for an account with neither an email nor a name", () => {
    expect(weakCandidates({ email: null, displayName: "  " })).toEqual([]);
  });
});

describe("naming an account", () => {
  it("accepts the full address, the account id, or the local part", () => {
    expect(matchesSelector(row, ["blair@local.invalid"])).toBe(true);
    expect(matchesSelector(row, ["acct-blair"])).toBe(true);
    expect(matchesSelector(row, ["blair"])).toBe(true);
  });

  it("does not match a different account, and does not match on an empty email", () => {
    expect(matchesSelector(row, ["alex"])).toBe(false);
    expect(matchesSelector({ accountId: "acct-x", email: null }, [""])).toBe(false);
  });
});

describe("the verdict on a rotation that has already been written", () => {
  const base: RotationOutcome = {
    accountId: "acct-blair",
    email: "blair@local.invalid",
    expectedVaults: 2,
    oldPasswordStillWorks: false,
    access: [
      { vaultId: "v1", r2Key: "vaults/v1.enc", ok: true },
      { vaultId: "v2", r2Key: "vaults/v2.enc", ok: true },
    ],
  };

  it("passes only when the old credential is dead and every vault still opens", () => {
    expect(rotationVerdict(base)).toEqual({ ok: true, reasons: [] });
  });

  it("fails when the retired credential still authenticates", () => {
    const v = rotationVerdict({ ...base, oldPasswordStillWorks: true });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("still authenticates");
  });

  it("names the vault that stopped opening rather than reporting a bare count", () => {
    const v = rotationVerdict({
      ...base,
      access: [base.access[0], { vaultId: "v2", r2Key: "vaults/v2.enc", ok: false, detail: "not an HD1 v2 blob" }],
    });
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(["lost access to vaults/v2.enc — not an HD1 v2 blob"]);
  });

  it("REFUSES to call an empty result a success — that is the lockout, stated as 0/0", () => {
    // The property this whole file exists for. A principal that held two envelopes and now reports
    // none is holding a freshly minted credential that opens nothing; read as a list of failures it
    // is empty, and every "no failures" check calls that ok.
    const v = rotationVerdict({ ...base, access: [] });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("only 0 of 2");
  });

  it("counts a partial disappearance too, not just a total one", () => {
    const v = rotationVerdict({ ...base, access: [base.access[0]] });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain("only 1 of 2");
  });

  it("passes an account that genuinely holds no envelopes, which is not the same reading", () => {
    // A support principal mid-onboarding owns nothing and holds nothing. Zero expected and zero
    // returned agree; it is the disagreement that is the alarm.
    expect(rotationVerdict({ ...base, expectedVaults: 0, access: [] }).ok).toBe(true);
  });
});

describe("what the command refuses to do", () => {
  it("defaults to the read-only check with no flags at all", () => {
    expect(parseRotateArgs(["node", "rotate.ts"])).toMatchObject({ mode: "check", method: "password", selectors: [], mintOrgEnvelope: false });
  });

  it("refuses --apply without a named account, rather than rotating every pilot at once", () => {
    expect(() => parseRotateArgs(["--apply"])).toThrow(/needs at least one --account/);
  });

  it("refuses --verify-access that would verify nothing", () => {
    expect(() => parseRotateArgs(["--verify-access"])).toThrow(/CURRENT_PASSWORD/);
    expect(() => parseRotateArgs(["--verify-access"], { CURRENT_PASSWORD: "hunter2" })).toThrow(/needs --account/);
  });

  it("refuses a method it does not understand instead of treating it as a password", () => {
    expect(() => parseRotateArgs(["--method", "passkey"])).toThrow(/must be password or recovery/);
  });

  it("reads --account repeatedly, lowercased, and takes the mint flag only under --apply", () => {
    const a = parseRotateArgs(["--apply", "--account", "Blair@Local.Invalid", "--account", "alex", "--mint-org-envelope"]);
    expect(a).toMatchObject({ mode: "apply", selectors: ["blair@local.invalid", "alex"], mintOrgEnvelope: true });
    expect(parseRotateArgs(["--mint-org-envelope"]).mintOrgEnvelope).toBe(false);
  });

  it("takes the current password only from the environment", () => {
    expect(parseRotateArgs(["--apply", "--account", "blair"], { CURRENT_PASSWORD: "s3cret" }).supplied).toBe("s3cret");
    // Passing it as an argument must not work: argv is visible in `ps` and kept in shell history.
    expect(parseRotateArgs(["--apply", "--account", "blair", "--current-password", "s3cret"]).supplied).toBeUndefined();
  });
});

describe("who a supplied password may be tried against", () => {
  it("applies it only to an explicitly named account", () => {
    const args = parseRotateArgs(["--apply", "--account", "blair"], { CURRENT_PASSWORD: "s3cret" });
    expect(suppliedAppliesTo(row, args)).toBe(true);
    // Trying one holder's secret against every row turns it into an oracle over the whole table.
    expect(suppliedAppliesTo({ accountId: "acct-alex", email: "alex@local.invalid" }, args)).toBe(false);
  });

  it("applies to nobody when none was supplied", () => {
    expect(suppliedAppliesTo(row, parseRotateArgs(["--apply", "--account", "blair"]))).toBe(false);
  });
});
