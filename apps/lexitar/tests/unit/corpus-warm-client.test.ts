import { describe, it, expect, vi, afterEach } from "vitest";

// The module holds one belief for the page — whether this deployment puts the record's PDFs in the
// request — so every case gets its own instance of it.
const fresh = async (answer: { status: number; body?: unknown }) => {
  vi.resetModules();
  vi.stubGlobal("fetch", async () =>
    new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    }),
  );
  return (await import("../../src/lib/corpus-warm-client")) as typeof import("../../src/lib/corpus-warm-client");
};

afterEach(() => vi.unstubAllGlobals());

describe("what the warm call teaches the page about attached reports", () => {
  it.each([
    ["a warm that wrote the cache", { warmed: true, written: 5120, read: 0 }, true],
    ["a provider with no pre-warm, which still attaches", { warmed: false, reason: "unsupported" }, true],
    ["a record that holds no PDFs yet, on a deployment that would attach them", { warmed: false, reason: "no_corpus" }, true],
    ["a deployment that attaches nothing", { warmed: false, reason: "off" }, false],
  ])("learns from %s", async (_case, body, attached) => {
    const m = await fresh({ status: 200, body });

    await m.warmCorpus("alex", "imperial");

    expect(m.reportsAreAttached()).toBe(attached);
  });

  // The regression this guards: the route softens its own 5xx to a 200 so a busy provider is not a
  // red request in the console. Read as "attached", that drops an attached PDF's transcription from
  // the question — while nothing else is carrying the document, because the corpus call is what
  // failed. The safe default is "not attached": keep sending the text.
  it("learns nothing from an attempt that failed, and keeps sending the transcription", async () => {
    const m = await fresh({ status: 200, body: { warmed: false, reason: "failed", errorCode: "ai_busy" } });

    await expect(m.warmCorpus("alex", "imperial")).resolves.toBe(false);

    expect(m.reportsAreAttached()).toBe(false);
  });

  it("learns nothing from a status it could not read", async () => {
    const m = await fresh({ status: 503 });

    await expect(m.warmCorpus("alex", "imperial")).resolves.toBe(false);

    expect(m.reportsAreAttached()).toBe(false);
  });
});
