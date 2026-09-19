import { describe, it, expect, vi, beforeEach } from "vitest";
import { RANGES_MODEL } from "../../src/lib/ranges-config";

// Mock the SDK so the Function's guard + non-streamed generation are exercised with no billable
// call. Unlike refresh-finding's mocked `.stream`, this Function calls `.create` directly.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { onRequestPost } from "../../functions/api/refresh-range";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";

const ENV = { PROVIDER_TOKEN: "provtok", RANGES_ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret",
    DB: fakeSessionDb(), STORE_PREFIX: "dev", };

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
      body: opts.body ?? JSON.stringify({ client: CLIENT, marker: "hsCRP" }),
    }),
    env: ENV,
  });
}

const bodyJson = async (res: Response) => JSON.parse(await res.text());

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
    expect((await call({ auth: "Bearer provtok", body: JSON.stringify({ marker: "hsCRP" }) })).status).toBe(400);
    expect((await call({ auth: "Bearer provtok", body: JSON.stringify({ client: CLIENT }) })).status).toBe(400);
  });

  it("400s when the marker has no measured unit on this client", async () => {
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client: CLIENT, marker: "not-a-marker" }) });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("does NOT 400 a dimensionless ratio marker (unit \"\") — e.g. a DEXA fat ratio", async () => {
    const ratioClient = {
      ...CLIENT,
      results: [{ marker: "Android/Gynoid % fat ratio", group: "Body Composition", source: "Scan", date: "2026-01-01", value: 1.1, unit: "" }],
    };
    createMock.mockResolvedValue(fakeResponse({ ...RANGE_JSON, unit: "" }));
    const res = await call({ auth: "Bearer provtok", body: JSON.stringify({ client: ratioClient, marker: "Android/Gynoid % fat ratio" }) });
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
    expect(parsed.range.generatedBy).toEqual({ mode: "prod", model: RANGES_MODEL });

    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe(RANGES_MODEL);
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

describe("/api/refresh-range R2 audit trail", () => {
  function callWithR2(store: Map<string, string>) {
    const env = { ...ENV, STORE_PREFIX: "dev", VAULT: { put: async (k: string, v: string) => void store.set(k, v) } };
    return onRequestPost({
      request: new Request("http://x/api/refresh-range", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer provtok", "cf-ray": "ray9" },
        body: JSON.stringify({ client: CLIENT, marker: "hsCRP" }),
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
