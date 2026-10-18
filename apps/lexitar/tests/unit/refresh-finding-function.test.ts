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
import { signSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { CORPUS_ACK } from "../../functions/_lib/inference/corpus";
import { useWorkerd } from "../support/miniflare";

// REPORTS unset — the corpus off — and bindings that throw on contact, to prove it stays off.
const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { PROVIDER_TOKEN: "provtok", FINDING_ANTHROPIC_API_KEY: "k", STORE_PREFIX: "dev",
  SESSION_SECRET: "test-secret", DB: NO_STORAGE, VAULT: NO_STORAGE };

// Whose record this is, and the account vouching for it. Required on every call whatever REPORTS is
// set to — these cases are about the relay's other contracts, so the ids are filled in here rather
// than repeated in every body.
const IDS = { clientId: "alex", accountId: "acct-1" };

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

/** Leaves a deliberately malformed body alone; everything else gets the ids. */
function withIds(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  try {
    return JSON.stringify({ ...IDS, ...JSON.parse(body) });
  } catch {
    return body;
  }
}

function call(opts: { auth?: string; body?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  return onRequestPost({
    request: new Request("http://x/api/refresh-finding", { method: "POST", headers, body: withIds(opts.body) ?? JSON.stringify({ client: CLIENT, ...IDS }) }),
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
    expect((await call({ auth: "Bearer provtok", body: JSON.stringify({ client: undefined }) })).status).toBe(400);
  });

  // The bearer is a deployment-wide secret. It buys entry to the route; it never says whose reports
  // may be read, so a caller holding only it has to name the account and be checked against it.
  it("400s a bearer-only caller that names no account, and never streams", async () => {
    const res = await onRequestPost({
      request: new Request("http://x/api/refresh-finding", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer provtok" },
        body: JSON.stringify({ client: CLIENT, clientId: "alex" }),
      }),
      env: ENV,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { errorCode: string }).errorCode).toBe("no_account_id");
    expect(streamMock).not.toHaveBeenCalled();
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
    const env = { ...ENV, STORE_PREFIX: "dev",
      VAULT: { get: (): never => { throw new Error("touched storage"); }, list: (): never => { throw new Error("touched storage"); },
               put: async (k: string, v: string) => { store.set(k, v); return { etag: k }; } } };
    return onRequestPost({
      request: new Request("http://x/api/refresh-finding", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer provtok", "cf-ray": "ray7" },
        body: JSON.stringify({ client: CLIENT, attempt: 1, ...IDS }),
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

describe("/api/refresh-finding generates in sight of the patient's reports", () => {
  const w = useWorkerd({ r2: true, perTest: true });

  async function alexWithAReport(): Promise<string> {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "alex", email: `alex-${id}@example.com` });
    const key = "dev/raw/alex/report.pdf";
    await w.bucket.put(key, new TextEncoder().encode("%PDF-1.4 report"));
    await recordRawObject(w.db, key, id, { pages: 2, bytes: 15 });
    return id;
  }

  const post = async (accountId: string | null, body: unknown) =>
    onRequestPost({
      request: new Request("http://x/api/refresh-finding", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer provtok",
                   ...(accountId ? { cookie: `hd_session=${await signSession({ SESSION_SECRET: "test-secret" }, accountId)}` } : {}) },
        body: JSON.stringify(body),
      }),
      env: { ...ENV, DB: w.db, VAULT: w.bucket, REPORTS: "always" } as never,
    });

  it("leads with the reports, ahead of the Finding request", async () => {
    const who = await alexWithAReport();

    const res = await post(who, { client: CLIENT, clientId: "alex" });
    await bodyText(res);

    const messages = streamMock.mock.calls[0][0].messages;
    expect(messages[0].content[0].type).toBe("document");
    expect(messages[1]).toEqual({ role: "assistant", content: CORPUS_ACK });
    expect(messages[2].role).toBe("user");
  });

  // Before a 200 commits, because after it the only channel left is the in-band sentinel — which the
  // browser reads as generation_failed and retries, three full Opus generations deep.
  it("404s a namespace the session's account does not own, with no stream and no sentinel", async () => {
    await alexWithAReport();
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "nobody", email: `nobody-${stranger}@example.com` });

    const res = await post(stranger, { client: CLIENT, clientId: "alex" });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("admits a patient's own session with no bearer at all", async () => {
    const who = await alexWithAReport();
    const res = await onRequestPost({
      request: new Request("http://x/api/refresh-finding", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `hd_session=${await signSession({ SESSION_SECRET: "test-secret" }, who)}` },
        body: JSON.stringify({ client: CLIENT, clientId: "alex" }),
      }),
      env: { ...ENV, DB: w.db, VAULT: w.bucket, REPORTS: "always" } as never,
    });

    expect(res.status).toBe(200);
  });
});
