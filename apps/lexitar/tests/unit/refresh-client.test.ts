import { describe, it, expect, vi, beforeEach } from "vitest";
import { FINDING_PORTION_KEYS } from "@pablotech/akesi/finding-assemble";
import { refreshFinding, type RefreshProgress, type RefreshEvent } from "../../src/lib/refresh-client";
import { findingInputsHash, isFindingStale } from "../../src/lib/staleness";
import { coreOnlyResponse } from "../fixtures/core-response";
import type { Client } from "../../src/lib/types";

const CLIENT = { displayName: "P", dob: "1980-01-01", gender: "male", watchlist: [], results: [] } as unknown as Client;

const valid = () => JSON.stringify(coreOnlyResponse());
/** A well-formed response the real validator rejects, naming `section` as missing. */
function missing(section: "latest" | "recent" | "overall"): string {
  const r = coreOnlyResponse();
  r.progression[section] = "";
  return JSON.stringify(r);
}

// Each string is its own stream chunk, so onProgress fires once per chunk.
function multiChunk(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}
const streamResponse = (text: string) => multiChunk([text]);
/** One fresh response per attempt, in order; the last repeats. */
const attempts = (...bodies: string[]) => {
  let i = 0;
  return async () => streamResponse(bodies[Math.min(i++, bodies.length - 1)]);
};

const fetchMock = vi.fn();
const bodyOf = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("refreshFinding — terminal vs. retryable", () => {
  it("a truncated / unparseable stream is TERMINAL — one attempt, no retry", async () => {
    fetchMock.mockResolvedValue(streamResponse('{"finding":'));
    await expect(refreshFinding(CLIENT, "tok")).rejects.toMatchObject({ errorCode: "truncated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a validation miss RETRIES with a correction, capped at 3 attempts", async () => {
    fetchMock.mockImplementation(attempts(missing("latest")));
    await expect(refreshFinding(CLIENT, "tok")).rejects.toThrow(/progression\.latest" missing/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(1).corrections[0]).toContain('progression.latest" missing');
  });

  // Sending only the newest rejection let the model fix one problem and reintroduce another every attempt.
  it("accumulates rejections across attempts rather than replacing them", async () => {
    fetchMock.mockImplementation(attempts(missing("latest"), missing("recent"), missing("overall")));
    await expect(refreshFinding(CLIENT, "tok")).rejects.toThrow();

    expect(bodyOf(0).corrections).toEqual([]);
    expect(bodyOf(1).corrections).toHaveLength(1);
    const third = bodyOf(2).corrections;
    expect(third).toHaveLength(2);
    expect(third[0]).toContain("progression.latest");
    expect(third[1]).toContain("progression.recent");
  });

  it("recovers on a later attempt once validation passes", async () => {
    fetchMock.mockImplementation(attempts(missing("latest"), valid()));
    const finding = await refreshFinding(CLIENT, "tok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(finding.inputsHash).toBe(await findingInputsHash(CLIENT));
    expect(await isFindingStale({ ...CLIENT, finding })).toBe(false);
    expect(finding.progression).toEqual(coreOnlyResponse().progression);
  });

  it("threads the abort signal to the fetch", async () => {
    fetchMock.mockImplementation(attempts(valid()));
    const ctrl = new AbortController();
    await refreshFinding(CLIENT, "tok", undefined, ctrl.signal);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ctrl.signal);
  });
});

describe("refreshFinding — portion-based progress", () => {
  it("reports N-of-total portions climbing monotonically within an attempt", async () => {
    fetchMock.mockImplementation(async () => multiChunk(['{"progression":1,', '"disease":2}']));
    const seen: RefreshProgress[] = [];
    await expect(refreshFinding(CLIENT, "tok", (p) => seen.push({ ...p }))).rejects.toThrow();
    const first = seen.filter((p) => p.attempt === 1);
    expect(first.map((p) => p.received)).toEqual([1, 2]);
    expect(first.at(-1)).toMatchObject({ received: 2, total: FINDING_PORTION_KEYS.length, attempt: 1, maxAttempts: 3 });
  });

  it("increments the attempt across a validation-retry (not a silent reset)", async () => {
    fetchMock.mockImplementation(attempts(missing("latest"), valid()));
    const seen: number[] = [];
    await refreshFinding(CLIENT, "tok", (p) => seen.push(p.attempt));
    expect(seen).toContain(1);
    expect(seen).toContain(2);
    expect(Math.max(...seen)).toBe(2);
  });
});

describe("refreshFinding — loop events for the audit beacon", () => {
  it("emits validation-fail (category-only) per retry then gave-up, never the correction prose", async () => {
    fetchMock.mockImplementation(attempts(missing("latest")));
    const events: RefreshEvent[] = [];
    await expect(refreshFinding(CLIENT, "tok", undefined, undefined, (e) => events.push(e))).rejects.toThrow();
    expect(events.filter((e) => e.event === "validation-fail")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ event: "gave-up", errorCode: "validation_exhausted" });
    for (const e of events) expect(JSON.stringify(e)).not.toContain("progression.latest");
  });

  it("emits truncated (terminal) on an unparseable stream", async () => {
    fetchMock.mockResolvedValue(streamResponse('{"finding":'));
    const events: RefreshEvent[] = [];
    await expect(refreshFinding(CLIENT, "tok", undefined, undefined, (e) => events.push(e))).rejects.toMatchObject({ errorCode: "truncated" });
    expect(events).toEqual([{ event: "truncated", attempt: 1, errorCode: "truncated" }]);
  });

  it("emits success on the winning attempt", async () => {
    fetchMock.mockImplementation(attempts(valid()));
    const events: RefreshEvent[] = [];
    await refreshFinding(CLIENT, "tok", undefined, undefined, (e) => events.push(e));
    expect(events).toEqual([{ event: "success", attempt: 1 }]);
  });
});
