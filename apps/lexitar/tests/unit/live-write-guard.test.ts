import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assertLiveWriteAllowed, liveWriteRefusal, push, pushRaw } from "../../scripts/vault-sync";

// CLAUDE.md: "No workstation writes the deployed vault." That rule was held only by prose, and the
// file itself says it wants a guard because prose catches the careful case and not the 11pm one.
// These tests are the guard's teeth: without CI or the explicit override, the write paths refuse.

const CI = process.env.CI;
const OVERRIDE = process.env.PLOVER_ALLOW_LOCAL_VAULT_WRITE;

beforeEach(() => {
  delete process.env.CI;
  delete process.env.PLOVER_ALLOW_LOCAL_VAULT_WRITE;
});

afterEach(() => {
  if (CI === undefined) delete process.env.CI;
  else process.env.CI = CI;
  if (OVERRIDE === undefined) delete process.env.PLOVER_ALLOW_LOCAL_VAULT_WRITE;
  else process.env.PLOVER_ALLOW_LOCAL_VAULT_WRITE = OVERRIDE;
  vi.restoreAllMocks();
});

describe("assertLiveWriteAllowed", () => {
  it("refuses on a workstation, and names ops.yml and the override", () => {
    expect(() => assertLiveWriteAllowed("the vault")).toThrow(/refusing to write the vault/);
    expect(liveWriteRefusal("x")).toContain("ops.yml");
    expect(liveWriteRefusal("x")).toContain("PLOVER_ALLOW_LOCAL_VAULT_WRITE");
  });

  it("allows the write in CI, which is where ops.yml runs it", () => {
    process.env.CI = "true";
    expect(() => assertLiveWriteAllowed("the vault")).not.toThrow();
  });

  it("allows an explicit override but banners it to stderr — silence is what makes it dangerous", () => {
    process.env.PLOVER_ALLOW_LOCAL_VAULT_WRITE = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => assertLiveWriteAllowed("the vault")).not.toThrow();
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("")).toMatch(/no audit trail/i);
  });
});

// The assert being correct in isolation says nothing about whether it is WIRED IN. These call the
// real exported writers and prove they refuse before doing any work — no wrangler, no fetch.
describe("the write paths are actually guarded", () => {
  it("push() refuses without touching R2", async () => {
    await expect(push("834bc60d-c937-467d-9e78-3caa734acf45")).rejects.toThrow(/refusing to write/);
  });

  it("pushRaw() refuses without touching R2", async () => {
    await expect(pushRaw("dev", "834bc60d", "scan.pdf", "/tmp/nope.pdf")).rejects.toThrow(/refusing to write/);
  });

  // Guard placement is load-bearing: it has to run BEFORE the etag read / network call, or the
  // refusal arrives after the side effect it exists to prevent. A credential-free environment
  // reaching R2 at all would fail differently, and that difference is the assertion.
  it("refuses for the guard's reason, not because a credential was missing", async () => {
    await expect(push("whoever")).rejects.toThrow(/ops\.yml/);
  });
});
