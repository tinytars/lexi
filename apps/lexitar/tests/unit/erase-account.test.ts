import { describe, it, expect, vi, afterEach } from "vitest";
import { eraseMyAccount, erasureSummary, ERASURE_REACH } from "../../src/lib/erase-account";

// The UI half of POST /api/account/erase. The route's own rules are pinned by
// tests/unit/erasure-function.test.ts; what is pinned here is that the browser asks the way the
// route demands, and that an incomplete erasure is reported as incomplete.
const reply = (status: number, body: unknown) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => vi.unstubAllGlobals());

describe("eraseMyAccount", () => {
  it("echoes the typed email as the confirmation the route requires", async () => {
    const fetchMock = reply(200, { r2Deleted: ["a", "b"], unattributable: 0, complete: true });
    await eraseMyAccount("owner@example.test");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/account/erase");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ confirmEmail: "owner@example.test" });
  });

  it("surfaces the route's own refusal message rather than a generic one", async () => {
    reply(400, { error: "type your account email exactly to confirm erasure", errorCode: "confirmation_mismatch" });
    await expect(eraseMyAccount("wrong@example.test")).rejects.toThrow(/type your account email exactly/);
  });

  it("carries the incompleteness through instead of reporting a count of files", async () => {
    reply(200, { r2Deleted: ["a"], unattributable: 3, complete: false });
    expect(await eraseMyAccount("owner@example.test")).toEqual({ deleted: 1, unattributable: 3, complete: false });
  });
});

describe("erasureSummary", () => {
  it("says what was left behind, and why, when the erasure was incomplete", () => {
    const text = erasureSummary({ deleted: 4, unattributable: 2, complete: false });
    expect(text).toMatch(/2 files were left in place/);
    expect(text).toMatch(/cannot prove they are yours/);
  });

  it("does not claim a clean sweep when unattributable objects remain", () => {
    expect(erasureSummary({ deleted: 4, unattributable: 2, complete: false })).not.toMatch(/^Deleted\. /);
  });

  it("states the count when everything was deleted", () => {
    expect(erasureSummary({ deleted: 1, unattributable: 0, complete: true })).toBe(
      `Deleted. 1 file removed, along with your account and its history. ${ERASURE_REACH}`,
    );
  });

  // DPG 9A.7 — a complete erasure still cannot recall what the model provider already cached, so the
  // limit belongs on the clean sweep too. Saying it only on the incomplete branch would read as though
  // a clean result had reached everywhere.
  it("states what erasure cannot reach on both branches, not only the incomplete one", () => {
    expect(erasureSummary({ deleted: 1, unattributable: 0, complete: true })).toContain(ERASURE_REACH);
    expect(erasureSummary({ deleted: 4, unattributable: 2, complete: false })).toContain(ERASURE_REACH);
    expect(ERASURE_REACH).toMatch(/cannot recall/);
  });
});
