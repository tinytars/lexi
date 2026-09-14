import { describe, it, expect } from "vitest";
import { pushDecision, describePushConflict } from "../../scripts/vault-sync";

// W76 — the operator half of W70's concurrency guarantee.
//
// The browser path is already covered: functions/api/vault/[id].ts returns 428 without a precondition
// and 412 on a stale one. The CLI had no equivalent — `wrangler r2 object put` is unconditional — so
// an operator sync overwrote a browser save that landed after the CLI's pull, silently and in full,
// because a vault write carries the whole record. These assertions are the rule that now stops it.

describe("whether a CLI push may overwrite what is in R2", () => {
  it("replaces only the exact version this run read", () => {
    expect(pushDecision("etag-a", "etag-a")).toBe("replace");
  });

  it("refuses when R2 moved under the run — the stale side loses, it does not win", () => {
    // The whole point. Before this, "etag-a" vs "etag-b" was not even asked, and the newer blob was
    // replaced by an older whole-record write.
    expect(pushDecision("etag-a", "etag-b")).toBe("conflict");
  });

  it("refuses when the object this run read has since been deleted", () => {
    expect(pushDecision("etag-a", null)).toBe("conflict");
  });

  it("creates only when the vault was absent at read time and is still absent", () => {
    expect(pushDecision(null, null)).toBe("create");
  });

  it("refuses to create over something that appeared in the meantime", () => {
    expect(pushDecision(null, "etag-a")).toBe("conflict");
  });

  it("refuses a push from a run that never read the vault at all", () => {
    // Not an exemption from the guard — the loudest case of it. A whole-record write built without
    // ever loading the record is the clobber this exists to stop.
    expect(pushDecision(undefined, "etag-a")).toBe("conflict");
    expect(pushDecision(undefined, null)).toBe("conflict");
  });
});

describe("what the operator is told", () => {
  it("names both versions, so the next step is obvious rather than a guess", () => {
    const m = describePushConflict("liz", "etag-a", "etag-b");
    expect(m).toContain("liz");
    expect(m).toContain("etag-a");
    expect(m).toContain("etag-b");
    expect(m).toMatch(/pull again/i);
  });

  it("distinguishes never-read, appeared-since, and deleted-since rather than one generic line", () => {
    expect(describePushConflict("liz", undefined, "e")).toMatch(/never read it/);
    expect(describePushConflict("liz", null, "e")).toMatch(/did not exist/);
    expect(describePushConflict("liz", "e", null)).toMatch(/has been deleted/);
  });
});
