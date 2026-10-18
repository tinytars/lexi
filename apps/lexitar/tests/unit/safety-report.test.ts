import { describe, it, expect, vi } from "vitest";
import { fileSafetyReport } from "../../src/lib/safety-report";

const reply = (status: number, body: unknown) =>
  vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

describe("fileSafetyReport", () => {
  it("posts the target and the note as one JSON body, and returns the reference", async () => {
    const fetchMock = reply(202, { filed: true, reference: "abc123" });
    vi.stubGlobal("fetch", fetchMock);

    const reference = await fileSafetyReport(
      { reason: "misleading-answer", subject: "t1-turn-2", feature: "chat" },
      "this looks dangerous",
    );

    expect(reference).toBe("abc123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/report");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      reason: "misleading-answer",
      subject: "t1-turn-2",
      feature: "chat",
      note: "this looks dangerous",
    });
  });

  // The user is owed the difference between "too many from here" and "reporting is off on this
  // deployment": one is worth retrying and the other is worth telling someone about.
  it("rethrows the route's own words, so a rate limit does not read as an outage", async () => {
    vi.stubGlobal("fetch", reply(429, { error: "too many reports from here in the last hour" }));
    await expect(fileSafetyReport({ reason: "illegal-content" }, "")).rejects.toThrow(
      "too many reports from here in the last hour",
    );
  });

  it("still throws when the failure carries no body to quote", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(fileSafetyReport({ reason: "abusive-account" }, "")).rejects.toThrow("Could not send this report.");
  });
});
