import { describe, it, expect, vi, beforeEach } from "vitest";
import { modelId } from "../../src/lib/model-config";

// Mock the SDK so the Function's guard + non-streamed generation are exercised with no billable
// call. Unlike refresh-finding's mocked `.stream`, this Function calls `.create` directly.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import type Anthropic from "@anthropic-ai/sdk";
import { onRequestPost } from "../../functions/api/refresh-range";
import { signSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { CORPUS_ACK } from "../../functions/_lib/inference/corpus";
import { fakeSessionDb } from "../support/session-db";
import { useWorkerd } from "../support/miniflare";

// REPORTS is unset in this ENV — a deployment that never turned the corpus on — so a VAULT that
// throws on contact is the assertion that these cases read no reports at all.
const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { PROVIDER_TOKEN: "provtok", RANGES_ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret",
    DB: fakeSessionDb(), VAULT: NO_STORAGE, STORE_PREFIX: "dev", };

const RANGE_JSON = {
  low: 0.5,
  high: 1.5,
  unit: "mg/L",
  meaning: "A marker of inflammation.",
  explanation: "Explanation of why this range fits the patient.",
  explanationImperial: null,
  generalLow: 0.3,
  generalHigh: 2.0,
  generalExplanation: "General population range by age and sex.",
};

function fakeResponse(json: unknown = RANGE_JSON, stopReason = "end_turn") {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    stop_reason: stopReason,
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

const CLIENT = {
  displayName: "P",
  dob: "1980-01-01",
  gender: "male",
  watchlist: [],
  results: [{ marker: "hsCRP", group: "inflammation", source: "s", date: "2026-01-01", value: 0.8, unit: "mg/L" }],
};

function call(opts: { auth?: string; body?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return onRequestPost({
    request: new Request("http://x/api/refresh-range", {
      method: "POST",
      headers,
      body: opts.body ?? JSON.stringify({ client: CLIENT, clientId: "alex", accountId: "acct-1", marker: "hsCRP" }),
    }),
    env: ENV,
  });
}

const bodyJson = async (res: Response) => JSON.parse(await res.text());

// The audit trail writes through the same binding the corpus reads from, so a put-only stub no
// longer types. Reads still throw: with REPORTS unset nothing may reach for a report.
const NO_STORAGE_BUCKET = {
  get: (): never => { throw new Error("touched storage"); },
  list: (): never => { throw new Error("touched storage"); },
};

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue(fakeResponse());
});

describe("/api/refresh-range guard", () => {
  it("401s without / with a wrong PROVIDER_TOKEN and never calls the model", async () => {
    expect((await call({})).status).toBe(401);
    expect((await call({ auth: "Bearer nope" })).status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("401s when the bearer is absent/wrong AND there is no valid session cookie either", async () => {
    expect((await call({ cookie: "hd_session=garbage" })).status).toBe(401);
    expect((await call({ auth: "Bearer nope", cookie: "hd_session=garbage" })).status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("dual-auth: accepts a valid hd_session cookie when no/wrong bearer is sent", async () => {
    const token = await signSession(ENV, "acct-1");
    const cookie = `hd_session=${token}`;

    const noBearer = await call({ cookie });
    expect(noBearer.status).toBe(200);

    const wrongBearer = await call({ auth: "Bearer nope", cookie });
    expect(wrongBearer.status).toBe(200);

    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("400s on malformed JSON, a missing client, and a missing marker", async () => {
    expect((await call({ auth: "Bearer provtok", body: "{not json" })).status).toBe(400);
    expect((await call({ auth: "Bearer provtok", body: JSON.stringify({ clientId: "alex", accountId: "acct-1", marker: "hsCRP" }) })).status).toBe(400);
    expect((await call({ auth: "Bearer provtok", body: JSON.stringify({ client: CLIENT, clientId: "alex", accountId: "acct-1" }) })).status).toBe(400);
  });

  it("400s when the marker has no measured unit on this client", async () => {
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client: CLIENT, clientId: "alex", accountId: "acct-1", marker: "not-a-marker" }) });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does NOT 400 a dimensionless ratio marker (unit \"\") — e.g. a DEXA fat ratio", async () => {
    const ratioClient = {
      ...CLIENT,
      results: [{ marker: "Android/Gynoid % fat ratio", group: "Body Composition", source: "Scan", date: "2026-01-01", value: 1.1, unit: "" }],
    };
    createMock.mockResolvedValue(fakeResponse({ ...RANGE_JSON, unit: "" }));
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client: ratioClient, clientId: "alex", accountId: "acct-1", marker: "Android/Gynoid % fat ratio" }) });
    expect(res.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0];
    expect(args.messages[0].content).toContain("dimensionless ratio");
  });
});

describe("/api/refresh-range generation", () => {
  it("200s with the generated PersonalizedRange, calling the model non-streamed", async () => {
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const parsed = await bodyJson(res);
    expect(parsed.marker).toBe("hsCRP");
    expect(parsed.range).toMatchObject({ low: 0.5, high: 1.5, unit: "mg/L" });
    expect(parsed.range.factorsHash).toEqual(expect.any(String));
    expect(parsed.range.generatedBy).toEqual({ mode: "prod", model: modelId("ranges") });

    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe(modelId("ranges"));
    expect(args.max_tokens).toBe(1024);
    expect(args.output_config.format.type).toBe("json_schema");
    expect(args.messages[0].content).toContain("Marker: hsCRP");
    expect(args.messages[0].content).toContain("Unit: mg/L");
  });

  it("500s with generation_failed when the model response fails validation, after exhausting all 3 retry attempts", async () => {
    createMock.mockResolvedValue(fakeResponse({ ...RANGE_JSON, unit: "wrong-unit" }));
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(500);
    expect((await bodyJson(res)).errorCode).toBe("generation_failed");
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("500s with generation_failed when the SDK call throws a non-transient, non-validation error — no retry", async () => {
    createMock.mockRejectedValue(new Error("overloaded_error"));
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(500);
    const parsed = await bodyJson(res);
    expect(parsed.errorCode).toBe("generation_failed");
    expect(parsed.error).toContain("overloaded_error");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("500s with generation_failed on insufficient_credit (402) — no retry", async () => {
    createMock.mockRejectedValue(Object.assign(new Error("credit balance too low"), { status: 402 }));
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(500);
    expect((await bodyJson(res)).errorCode).toBe("generation_failed");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient (429/529-classified) Anthropic error and succeeds on a later attempt", async () => {
    createMock
      .mockRejectedValueOnce(Object.assign(new Error("Overloaded"), { status: 529 }))
      .mockResolvedValueOnce(fakeResponse());
    const res = await call({ auth: "Bearer provtok" });
    expect(res.status).toBe(200);
    const parsed = await bodyJson(res);
    expect(parsed.range).toMatchObject({ low: 0.5, high: 1.5, unit: "mg/L" });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("logs the generation's token usage on success (cost visibility)", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(l));
    try {
      await call({ auth: "Bearer provtok" });
    } finally {
      spy.mockRestore();
    }
    const usageLog = logs.map((l) => JSON.parse(l)).find((e) => e.usage);
    expect(usageLog).toMatchObject({ route: "/api/refresh-range", status: 200, usage: { input: 3, output: 4 } });
  });
});

describe("/api/refresh-range answers in sight of the patient's reports", () => {
  const w = useWorkerd({ r2: true, perTest: true });
  const env = () =>
    ({ PROVIDER_TOKEN: "provtok", RANGES_ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret",
       DB: w.db, VAULT: w.bucket, STORE_PREFIX: "dev", REPORTS: "always" }) as never;

  async function alexWithAReport(): Promise<string> {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "alex", email: `alex-${id}@example.com` });
    const key = "dev/raw/alex/report.pdf";
    await w.bucket.put(key, new TextEncoder().encode("%PDF-1.4 report"));
    await recordRawObject(w.db, key, id, { pages: 2, bytes: 15 });
    return id;
  }

  const post = async (headers: Record<string, string>, body: unknown) =>
    onRequestPost({
      request: new Request("http://x/api/refresh-range", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      env: env(),
    });

  const corpusOf = (round: number) =>
    JSON.stringify((createMock.mock.calls[round][0] as { messages: Anthropic.MessageParam[] }).messages.slice(0, 2));

  it("leads with the reports, ahead of the marker question", async () => {
    const who = await alexWithAReport();

    const res = await post({ cookie: `hd_session=${await signSession(ENV, who)}` }, { client: CLIENT, clientId: "alex", marker: "hsCRP" });

    expect(res.status).toBe(200);
    const messages = (createMock.mock.calls[0][0] as { messages: Anthropic.MessageParam[] }).messages;
    expect((messages[0].content as Anthropic.ContentBlockParam[])[0].type).toBe("document");
    expect(messages[1]).toEqual({ role: "assistant", content: CORPUS_ACK });
    expect(messages[2].content).toContain("Marker: hsCRP");
  });

  // Three attempts share one cache entry only if all three send the same bytes — the retry ladder
  // is the cheapest place in the app to accidentally pay for the whole record three times.
  it("sends the same corpus on a retry", async () => {
    const who = await alexWithAReport();
    createMock
      .mockRejectedValueOnce(Object.assign(new Error("Overloaded"), { status: 529 }))
      .mockResolvedValueOnce(fakeResponse());

    await post({ cookie: `hd_session=${await signSession(ENV, who)}` }, { client: CLIENT, clientId: "alex", marker: "hsCRP" });

    expect(corpusOf(1)).toBe(corpusOf(0));
  });

  // The provider bearer opens the route; it has never opened a namespace, and must not start here.
  it("404s when the named account does not own the record, and calls no model", async () => {
    await alexWithAReport();
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "nobody", email: `nobody-${stranger}@example.com` });

    const res = await post({ authorization: "Bearer provtok" }, { client: CLIENT, clientId: "alex", accountId: stranger, marker: "hsCRP" });

    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s when a bearer-only caller names no account", async () => {
    await alexWithAReport();

    const res = await post({ authorization: "Bearer provtok" }, { client: CLIENT, clientId: "alex", marker: "hsCRP" });

    expect(res.status).toBe(400);
    expect((await bodyJson(res)).errorCode).toBe("no_account_id");
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("/api/refresh-range R2 audit trail", () => {
  function callWithR2(store: Map<string, string>) {
    const env = { ...ENV, STORE_PREFIX: "dev", VAULT: { ...NO_STORAGE_BUCKET, put: async (k: string, v: string) => { store.set(k, v); return { etag: k }; } } };
    return onRequestPost({
      request: new Request("http://x/api/refresh-range", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer provtok", "cf-ray": "ray9" },
        body: JSON.stringify({ client: CLIENT, clientId: "alex", accountId: "acct-1", marker: "hsCRP" }),
      }),
      env,
    });
  }

  it("persists accepted + success (with usage) to R2 under a dated prefix", async () => {
    const store = new Map<string, string>();
    await callWithR2(store);
    const events = [...store.values()].map((v) => JSON.parse(v));
    expect(events.map((e) => e.event).sort()).toEqual(["accepted", "success"]);
    const success = events.find((e) => e.event === "success");
    expect(success).toMatchObject({ usage: { input: 3, output: 4 } });
    for (const k of store.keys()) expect(k).toMatch(/^dev\/logs\/refresh-range\/\d{4}-\d{2}-\d{2}\/ray9-\d\.json$/);
  });
});
