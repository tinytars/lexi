import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCorpusWarmer, KEEPALIVE_INTERVAL_MS, MAX_IDLE_KEEPALIVES } from "../../src/lib/corpus-warm";
import { createCorpusLane } from "../../src/lib/corpus-lane";
import { warmCorpus, reportsAreAttached } from "../../src/lib/corpus-warm-client";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// W86 — a warm now queues through the corpus lane (corpus-lane.ts) instead of leaving inside
// select(), so it lands a microtask later. Every assertion below drains the lane first; the async
// timer helpers do the same for the keepalives, which queue one behind another by design.
const drain = () => vi.advanceTimersByTimeAsync(0);

describe("createCorpusWarmer", () => {
  it("warms the record as soon as it is selected", async () => {
    const warm = vi.fn().mockResolvedValue(true);

    createCorpusWarmer(warm).select("alex");
    await drain();

    expect(warm).toHaveBeenCalledExactlyOnceWith("alex");
  });

  it("refreshes the entry before it can expire", async () => {
    const warm = vi.fn().mockResolvedValue(true);
    createCorpusWarmer(warm).select("alex");

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);

    expect(warm).toHaveBeenCalledTimes(2);
    expect(KEEPALIVE_INTERVAL_MS).toBeLessThan(5 * 60 * 1000);
  });

  // The point of the cap: past it, holding the entry has cost more than rebuilding it would.
  it("stops refreshing a record nobody is asking about, and never bills past the cap", async () => {
    const warm = vi.fn().mockResolvedValue(true);
    createCorpusWarmer(warm).select("alex");

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * (MAX_IDLE_KEEPALIVES + 10));

    expect(warm).toHaveBeenCalledTimes(MAX_IDLE_KEEPALIVES + 1);
  });

  it("starts the budget over when the patient comes back to the tab", async () => {
    const warm = vi.fn().mockResolvedValue(true);
    const warmer = createCorpusWarmer(warm);
    warmer.select("alex");
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * MAX_IDLE_KEEPALIVES);
    warm.mockClear();

    warmer.wake();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * MAX_IDLE_KEEPALIVES);

    expect(warm).toHaveBeenCalledTimes(MAX_IDLE_KEEPALIVES + 1);
  });

  it("does nothing on wake before any record is open", async () => {
    const warm = vi.fn().mockResolvedValue(true);

    createCorpusWarmer(warm).wake();
    await drain();

    expect(warm).not.toHaveBeenCalled();
  });

  it("stops warming a closed vault, and a switch warms the new record only", async () => {
    const warm = vi.fn().mockResolvedValue(true);
    const warmer = createCorpusWarmer(warm);

    warmer.select("alex");
    warmer.select("blake");
    await drain();
    warm.mockClear();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(warm).toHaveBeenCalledExactlyOnceWith("blake");

    warmer.select(null);
    warm.mockClear();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 3);
    expect(warm).not.toHaveBeenCalled();
  });

  // The lane can hold a queued warm past the moment the patient moves on. Paying a cache write for a
  // record nobody has open is the one thing the budget above exists to prevent.
  it("drops a queued warm for a record the patient has already left", async () => {
    const warm = vi.fn().mockResolvedValue(true);
    const lane = createCorpusLane();
    const warmer = createCorpusWarmer(warm, lane);

    // Occupies the lane, so the warmer's own task has to queue behind it.
    let release!: () => void;
    void lane.run(() => new Promise<void>((r) => (release = r)));
    await drain();

    warmer.select("alex");
    warmer.select(null);
    release();
    await drain();

    expect(warm).not.toHaveBeenCalled();
  });

  // Two callers, one isolate: the sweep and the warmer must not both have a whole record in flight.
  it("waits for a corpus request another caller already has in the lane", async () => {
    const warm = vi.fn().mockResolvedValue(true);
    const lane = createCorpusLane();
    let release!: () => void;
    void lane.run(() => new Promise<void>((r) => (release = r)));

    createCorpusWarmer(warm, lane).select("alex");
    await drain();
    expect(warm).not.toHaveBeenCalled();

    release();
    await drain();
    expect(warm).toHaveBeenCalledExactlyOnceWith("alex");
  });

  // A cold cache is a slower answer, never a wrong one — a failed warm must not take the timer with it.
  it("keeps refreshing after a warm that fails", async () => {
    const warm = vi.fn().mockRejectedValue(new Error("offline"));
    createCorpusWarmer(warm).select("alex");
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 2);

    expect(warm).toHaveBeenCalledTimes(3);
  });
});

describe("warmCorpus", () => {
  it("asks the server to warm this record, under the active unit system", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ warmed: true, written: 5120, read: 0 })));
    vi.stubGlobal("fetch", fetchMock);

    expect(await warmCorpus("alex", "metric")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/corpus-warm");
    expect(JSON.parse(init.body as string)).toEqual({ clientId: "alex", unitSystem: "metric" });
  });

  // A record with no reports, a deployment with REPORTS off, a provider without prompt caching, a
  // record too large to send — none of it is a condition a patient should be shown, because none of
  // it stops them asking a question.
  it("reports nothing warmed rather than throwing, whatever the server says", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ warmed: false, reason: "no_corpus" }))));
    expect(await warmCorpus("alex", "imperial")).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 422 })));
    expect(await warmCorpus("alex", "imperial")).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    expect(await warmCorpus("alex", "imperial")).toBe(false);
  });
});

// Whether the PDF is already in the request decides whether its transcription is a second copy of
// one document or the only copy there is, so a wrong answer here is either doubled tokens or a
// model that cannot see the attachment at all (CORPUS.md).
describe("reportsAreAttached", () => {
  const replies = (payload: unknown, status = 200) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status })));

  // A fresh module, because this pins the value the app starts life with: the safe default is to
  // keep sending the transcription, so a deployment we have not heard from yet never loses a PDF.
  it("answers no before the first warm has come back", async () => {
    vi.resetModules();
    const fresh = await import("../../src/lib/corpus-warm-client");
    expect(fresh.reportsAreAttached()).toBe(false);
  });

  it("answers no once the deployment says REPORTS is off", async () => {
    replies({ warmed: false, reason: "off" });
    await warmCorpus("alex", "metric");
    expect(reportsAreAttached()).toBe(false);
  });

  // Each of these means the documents ARE in the request — only the pre-warm did not happen.
  it.each([
    ["this record has no PDFs yet", { warmed: false, reason: "no_corpus" }],
    ["the provider has no pre-warm", { warmed: false, reason: "unsupported" }],
    ["the entry was written", { warmed: true, written: 5120, read: 0 }],
  ])("answers yes when %s", async (_why, payload) => {
    replies({ warmed: false, reason: "off" });
    await warmCorpus("alex", "metric");

    replies(payload);
    await warmCorpus("alex", "metric");

    expect(reportsAreAttached()).toBe(true);
  });

  // A refused or unreachable warm says nothing about the deployment, so the last known answer stands.
  it("keeps the last answer when the warm call fails", async () => {
    replies({ warmed: false, reason: "no_corpus" });
    await warmCorpus("alex", "metric");

    replies({ error: "corpus too large" }, 422);
    await warmCorpus("alex", "metric");

    expect(reportsAreAttached()).toBe(true);
  });
});
