import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK so the Function's guard + the streaming relay (headers-first, text deltas, the
// in-band [[REFRESH_ERROR]] sentinel) are exercised with no billable call. The stream() mock
// returns an async-iterable with a finalMessage(), matching the SDK's MessageStream shape.
const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: streamMock };
  },
}));

import { onRequestPost } from "../../functions/api/refresh-finding";

const ENV = { PROVIDER_TOKEN: "provtok", FINDING_ANTHROPIC_API_KEY: "k", STORE_PREFIX: "dev", };

function fakeStream(deltas: string[], throwFinal?: string) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const t of deltas) yield { type: "content_block_delta", delta: { type: "text_delta", text: t } };
    },
    finalMessage: async () => {
      if (throwFinal) throw new Error(throwFinal);
      return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [] };
    },
  };
}

const CLIENT = { displayName: "P", dob: "1980-01-01", gender: "male", watchlist: [], results: [] };

function call(opts: { auth?: string; body?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  return onRequestPost({
    request: new Request("http://x/api/refresh-finding", { method: "POST", headers, body: opts.body ?? JSON.stringify({ client: CLIENT }) }),
    env: ENV,
  });
}

const bodyText = async (res: Response) => new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));

beforeEach(() => {
  streamMock.mockReset();
  streamMock.mockReturnValue(fakeStream(['{"finding":', '"partial"}']));
});

describe("/api/refresh-finding guard", () => {
  it("401s without / with a wrong PROVIDER_TOKEN and never streams", async () => {
    expect((await call({})).status).toBe(401);
    expect((await call({ auth: "Bearer nope" })).status).toBe(401);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("400s on malformed JSON and on a missing client", async () => {
    expect((await call({ auth: "Bearer provtok", body: "{not json" })).status).toBe(400);
    expect((await call({ auth: "Bearer provtok", body: JSON.stringify({}) })).status).toBe(400);
  });
});

describe("/api/refresh-finding streaming", () => {
  it("200s and streams the Opus text deltas headers-first", async () => {
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await bodyText(res)).toBe('{"finding":"partial"}');
    // Opus 128k + adaptive thinking on this opus model.
    const args = streamMock.mock.calls[0][0];
    expect(args.model).toBe("claude-opus-4-7");
    expect(args.max_tokens).toBe(128000);
    expect(args.thinking).toEqual({ type: "adaptive" });
  });

  it("appends the correction to the user message when re-requested", async () => {
    await call({ auth: "Bearer provtok", body: JSON.stringify({ client: CLIENT, correction: "studyResults[0] group missing" }) });
    const args = streamMock.mock.calls[0][0];
    expect(args.messages[0].content).toContain("CORRECTION");
    expect(args.messages[0].content).toContain("studyResults[0] group missing");
  });

  it("signals a post-header failure in-band via [[REFRESH_ERROR]] (still HTTP 200)", async () => {
    streamMock.mockReturnValue(fakeStream(["{...}"], "overloaded_error"));
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    expect(await bodyText(res)).toContain("[[REFRESH_ERROR]] overloaded_error");
  });

  it("passes the request's abort signal to the Anthropic stream (W39 cancel → stop spending)", async () => {
    const res = await call({ auth: "Bearer provtok" });
    await bodyText(res); // drain so the stream body runs
    expect(streamMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("logs the generation's token usage on completion (W39 cost visibility)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(l));
    try {
      const res = await call({ auth: "Bearer provtok" });
      await bodyText(res); // drain so finalMessage() + the usage log run
    } finally {
      spy.mockRestore();
    }
    const usageLog = logs.map((l) => JSON.parse(l)).find((e) => e.usage);
    expect(usageLog).toMatchObject({ route: "/api/refresh-finding", status: 200, usage: { input: 1, output: 1 } });
  });
});

describe("/api/refresh-finding R2 audit trail (W39 Phase 3)", () => {
  function callWithR2(store: Map<string, string>, deltas: string[]) {
    streamMock.mockReturnValue(fakeStream(deltas));
    const env = { ...ENV, STORE_PREFIX: "dev", VAULT: { put: async (k: string, v: string) => void store.set(k, v) } };
    return onRequestPost({
      request: new Request("http://x/api/refresh-finding", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer provtok", "cf-ray": "ray7" },
        body: JSON.stringify({ client: CLIENT, attempt: 1 }),
      }),
      env,
    });
  }

  it("persists accepted + stream-done (with usage) to R2 under a dated prefix", async () => {
    const store = new Map<string, string>();
    const res = await callWithR2(store, ["{}"]);
    await bodyText(res); // drain so the stream body (and its stream-done audit) runs
    const events = [...store.values()].map((v) => JSON.parse(v));
    expect(events.map((e) => e.event).sort()).toEqual(["accepted", "stream-done"]);
    const done = events.find((e) => e.event === "stream-done");
    expect(done).toMatchObject({ attempt: 1, usage: { input: 1, output: 1 } });
    for (const k of store.keys()) expect(k).toMatch(/^dev\/logs\/refresh-finding\/\d{4}-\d{2}-\d{2}\/ray7-\d\.json$/);
  });
});
