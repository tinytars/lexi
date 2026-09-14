import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "../../src/lib/types";

// Keep the real (separately-tested) extractJson so the parse boundary is exercised for real; stub
// only validation + assembly + the SubtleCrypto hashes so we can drive the classification loop
// deterministically without a full valid Finding.
vi.mock("@pablotech/akesi-pil/finding-assemble", async (orig) => {
  const actual = (await orig()) as typeof import("@pablotech/akesi-pil/finding-assemble");
  return {
    ...actual,
    validateFindingWithInputs: vi.fn(),
    assembleFinding: vi.fn(() => ({ assembled: true }) as never),
  };
});
vi.mock("../../src/lib/staleness", () => ({
  findingInputsHash: async () => "ih",
  nodeHashes: async () => ({}),
}));
vi.mock("@pablotech/akesi-pil/finding-generate", () => ({ plannedLabels: () => [], populatedNoteEntries: () => [] }));

import { FINDING_PORTION_KEYS } from "@pablotech/akesi-pil/finding-assemble";
import { refreshFinding, type RefreshProgress, type RefreshEvent } from "../../src/lib/refresh-client";
import { validateFindingWithInputs } from "@pablotech/akesi-pil/finding-assemble";

const CLIENT = { displayName: "P", dob: "1980-01-01", gender: "male", watchlist: [], results: [] } as unknown as Client;

function streamResponse(text: string): Response {
  return multiChunk([text]);
}

// Emit each string as its own stream chunk, so onProgress fires once per chunk (mimics the model
// streaming sections in order). The concatenation must be the full response text.
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

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(validateFindingWithInputs).mockReset();
});

describe("refreshFinding — terminal vs. retryable (W39)", () => {
  it("a truncated / unparseable stream is TERMINAL — one attempt, no retry", async () => {
    fetchMock.mockResolvedValue(streamResponse('{"finding":')); // cut off mid-object
    await expect(refreshFinding(CLIENT, "tok")).rejects.toMatchObject({ errorCode: "truncated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(validateFindingWithInputs).not.toHaveBeenCalled();
  });

  it("a validation miss RETRIES with a correction, capped at 3 attempts", async () => {
    fetchMock.mockImplementation(async () => streamResponse('{"ok":true}')); // fresh body each attempt
    vi.mocked(validateFindingWithInputs).mockImplementation(() => {
      throw new Error("studyResults[0] group missing");
    });
    await expect(refreshFinding(CLIENT, "tok")).rejects.toThrow(/group missing/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS
    // the 2nd POST carries the previous failure as a correction
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondBody.corrections[0]).toContain("group missing");
  });

  // W72 — EVERY prior rejection, not just the latest. Sending only the newest is what made a real
  // refresh burn all six attempts: the model fixed each named problem and broke a different one,
  // never once seeing the accumulated list. W67 fixed that in the CLI and left the browser path —
  // the one patients actually use — on the singular wording.
  it("accumulates rejections across attempts rather than replacing them", async () => {
    fetchMock.mockImplementation(async () => streamResponse('{"ok":true}'));
    let n = 0;
    vi.mocked(validateFindingWithInputs).mockImplementation(() => {
      throw new Error(`rejection number ${++n}`);
    });
    await expect(refreshFinding(CLIENT, "tok")).rejects.toThrow();

    const bodyOf = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string);
    expect(bodyOf(0).corrections).toEqual([]);
    expect(bodyOf(1).corrections).toHaveLength(1);
    const third = bodyOf(2).corrections;
    expect(third).toHaveLength(2);
    // The FIRST rejection is still there on the last attempt — that is the whole point.
    expect(third[0]).toContain("rejection number 1");
    expect(third[1]).toContain("rejection number 2");
  });

  it("recovers on a later attempt once validation passes", async () => {
    fetchMock.mockImplementation(async () => streamResponse('{"ok":true}'));
    vi.mocked(validateFindingWithInputs)
      .mockImplementationOnce(() => {
        throw new Error("first miss");
      })
      .mockImplementationOnce(() => {});
    await expect(refreshFinding(CLIENT, "tok")).resolves.toMatchObject({ assembled: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("threads the abort signal to the fetch", async () => {
    fetchMock.mockResolvedValue(streamResponse('{"ok":true}'));
    const ctrl = new AbortController();
    await refreshFinding(CLIENT, "tok", undefined, ctrl.signal);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ctrl.signal);
  });
});

describe("refreshFinding — portion-based progress (W39 Phase 2)", () => {
  it("reports N-of-total portions climbing monotonically within an attempt", async () => {
    // two chunks, each introducing one more top-level portion key. W65 — `disease`, not
    // `studyResults`: the core stopped narrating studyResults when the leaf took it over, so it is
    // no longer one of FINDING_PORTION_KEYS and streaming it would move the bar by nothing.
    fetchMock.mockResolvedValue(multiChunk(['{"progression":1,', '"disease":2}']));
    const seen: RefreshProgress[] = [];
    await refreshFinding(CLIENT, "tok", (p) => seen.push({ ...p }));
    expect(seen.map((p) => p.received)).toEqual([1, 2]); // "progression" then +"disease"
    // `total` is FINDING_PORTION_KEYS.length — read it rather than restating the number, so the next
    // section that moves to a leaf does not need this literal edited too.
    expect(seen.at(-1)).toMatchObject({ received: 2, total: FINDING_PORTION_KEYS.length, attempt: 1, maxAttempts: 3 });
  });

  it("increments the attempt across a validation-retry (not a silent reset)", async () => {
    fetchMock.mockImplementation(async () => multiChunk(['{"progression":1}']));
    vi.mocked(validateFindingWithInputs)
      .mockImplementationOnce(() => {
        throw new Error("first miss");
      })
      .mockImplementationOnce(() => {});
    const attempts: number[] = [];
    await refreshFinding(CLIENT, "tok", (p) => attempts.push(p.attempt));
    expect(attempts).toContain(1);
    expect(attempts).toContain(2); // the retry still reports attempt 2 to the model + Diagnostics log (no longer shown on the button — W41)
    expect(Math.max(...attempts)).toBe(2);
  });
});

describe("refreshFinding — loop events for the audit beacon (W39 Phase 3)", () => {
  it("emits validation-fail (category-only) per retry then gave-up, never the correction prose", async () => {
    fetchMock.mockImplementation(async () => streamResponse('{"ok":true}'));
    vi.mocked(validateFindingWithInputs).mockImplementation(() => {
      throw new Error("studyResults[0] group missing"); // prose — must NOT reach an event
    });
    const events: RefreshEvent[] = [];
    await expect(refreshFinding(CLIENT, "tok", undefined, undefined, (e) => events.push(e))).rejects.toThrow();
    expect(events.filter((e) => e.event === "validation-fail")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ event: "gave-up", errorCode: "validation_exhausted" });
    for (const e of events) {
      expect(e.reasonCategory ?? "").not.toContain("group missing");
      expect(JSON.stringify(e)).not.toContain("group missing");
    }
  });

  it("emits truncated (terminal) on an unparseable stream", async () => {
    fetchMock.mockResolvedValue(streamResponse('{"finding":'));
    const events: RefreshEvent[] = [];
    await expect(refreshFinding(CLIENT, "tok", undefined, undefined, (e) => events.push(e))).rejects.toMatchObject({ errorCode: "truncated" });
    expect(events).toEqual([{ event: "truncated", attempt: 1, errorCode: "truncated" }]);
  });

  it("emits success on the winning attempt", async () => {
    fetchMock.mockResolvedValue(streamResponse('{"ok":true}'));
    vi.mocked(validateFindingWithInputs).mockImplementation(() => {});
    const events: RefreshEvent[] = [];
    await refreshFinding(CLIENT, "tok", undefined, undefined, (e) => events.push(e));
    expect(events).toEqual([{ event: "success", attempt: 1 }]);
  });
});
