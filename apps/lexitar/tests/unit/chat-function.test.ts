import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Anthropic SDK so the Function's own behaviour (guard, validation,
// relay contract, tool-use payload, error mapping, PHI-free logging) is exercised with
// no live billable call. vi.hoisted lets the mocked create() be reachable from tests.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { onRequestPost } from "../../functions/api/chat";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "./_session-db";

const ENV = { SESSION_SECRET: "test-secret",
    DB: fakeSessionDb(), ANTHROPIC_API_KEY: "k" };

const MSGS = [{ role: "user", content: "CONTEXT:\n{}\n\nQUESTION:\nwhat changed?" }];

async function call(opts: { auth?: "valid" | "bogus"; body?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth === "valid") headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  else if (opts.auth === "bogus") headers.cookie = "hd_session=bogus";
  return onRequestPost({
    request: new Request("http://local/api/chat", {
      method: "POST",
      headers,
      body: opts.body ?? JSON.stringify({ messages: MSGS }),
    }),
    env: ENV,
  });
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({
    content: [{ type: "text", text: "an answer" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
});

describe("/api/chat guard + validation", () => {
  it("401s with no session", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(create).not.toHaveBeenCalled();
  });

  it("401s with a bogus session cookie", async () => {
    expect((await call({ auth: "bogus" })).status).toBe(401);
  });

  it("400s on a malformed JSON body", async () => {
    const res = await call({ auth: "valid", body: "{not json" });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("400s on missing/empty/invalid messages", async () => {
    expect((await call({ auth: "valid", body: JSON.stringify({ messages: [] }) })).status).toBe(400);
    expect((await call({ auth: "valid", body: JSON.stringify({ messages: "nope" }) })).status).toBe(400);
    expect((await call({ auth: "valid", body: JSON.stringify({ messages: [{ role: "system", content: "x" }] }) })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  // W46 Phase 6 — a chat turn's content can now be an array of content blocks (image + text),
  // not just a bare string; validateMessages already accepted `Array.isArray(content)` generically
  // (the same shape tool_use/tool_result rounds already used), so this is a regression guard, not
  // a new code path.
  it("accepts a message whose content is an image-blocks-then-text array", async () => {
    const imageMsgs = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Zm9v" } },
        { type: "text", text: "CONTEXT:\n{}\n\nQUESTION:\nwhat is this?" },
      ],
    }];
    const res = await call({ auth: "valid", body: JSON.stringify({ messages: imageMsgs }) });
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ messages: imageMsgs }));
  });

  // W46 Phase 6 — raised from 512 KB to 8 MB so a turn carrying compressed-image base64 fits.
  it("413s only once the body exceeds the new 8 MB cap, not at the old 512 KB one", async () => {
    const bigButUnderCap = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1_000_000) }] });
    expect((await call({ auth: "valid", body: bigButUnderCap })).status).not.toBe(413);
    const overCap = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(9 * 1024 * 1024) }] });
    expect((await call({ auth: "valid", body: overCap })).status).toBe(413);
  });
});

describe("/api/chat relay contract", () => {
  it("returns { kind: 'answer', answer } when the model ends its turn", async () => {
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "answer", answer: "an answer" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("relays the browser's running messages verbatim and offers the tool by default", async () => {
    await call({ auth: "valid" });
    const arg = create.mock.calls[0][0] as { messages: unknown[]; tools?: { name: string }[] };
    expect(arg.messages).toEqual(MSGS);
    expect(arg.tools?.[0].name).toBe("get_marker_readings");
  });

  it("returns a tool_use payload (assistant blocks + toolUses) when the model calls a tool", async () => {
    const content = [
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "tu_1", name: "get_marker_readings", input: { markers: ["Vitamin B12"] } },
    ];
    create.mockResolvedValue({ content, stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 } });
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("tool_use");
    expect(body.toolUses).toEqual([{ id: "tu_1", name: "get_marker_readings", input: { markers: ["Vitamin B12"] } }]);
    // The raw assistant content blocks are relayed so the browser can append them before the tool_result.
    expect(body.assistant).toEqual(content);
  });

  it("drops tools on the final forced round so the model must answer", async () => {
    await call({ auth: "valid", body: JSON.stringify({ messages: MSGS, final: true }) });
    const arg = create.mock.calls[0][0] as { tools?: unknown };
    expect(arg.tools).toBeUndefined();
  });

  it("answers a plain question in a single round (no tool_use)", async () => {
    const res = await call({ auth: "valid" });
    expect((await res.json()).kind).toBe("answer");
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("/api/chat units-system instruction (W14)", () => {
  const systemOf = () => (create.mock.calls[0][0] as { system: string }).system;

  it("names SI in the system prompt when unitSystem=metric", async () => {
    await call({ auth: "valid", body: JSON.stringify({ messages: MSGS, unitSystem: "metric" }) });
    expect(systemOf()).toContain("SI units");
  });

  it("names US-conventional units when unitSystem=imperial (and on the default)", async () => {
    await call({ auth: "valid", body: JSON.stringify({ messages: MSGS, unitSystem: "imperial" }) });
    expect(systemOf()).toContain("US-conventional units");
  });

  it("defaults to US when the field is absent (matches the app's default selector)", async () => {
    await call({ auth: "valid" });
    expect(systemOf()).toContain("US-conventional units");
  });
});

describe("/api/chat error mapping", () => {
  it("maps a credit-balance error to 402 insufficient_credit", async () => {
    create.mockRejectedValue({ status: 400, message: "Your credit balance is too low to access the Anthropic API." });
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ errorCode: "insufficient_credit" });
  });

  it("maps a rate-limit error to 503 ai_busy", async () => {
    create.mockRejectedValue({ status: 429, type: "rate_limit_error" });
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ errorCode: "ai_busy" });
  });
});

describe("/api/chat logging is PHI-free", () => {
  let logged: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = [];
    spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); });
  });
  afterEach(() => spy.mockRestore());

  it("logs request shape but never the messages or answer", async () => {
    await onRequestPost({
      request: new Request("http://local/api/chat", {
        method: "POST",
        headers: { cookie: `hd_session=${await signSession(ENV, "acct-1")}`, "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "SECRET_PHI in here" }] }),
      }),
      env: ENV,
    });
    expect(logged.length).toBeGreaterThan(0);
    const line = logged.find((l) => l.includes('"/api/chat"')) ?? "";
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ route: "/api/chat", status: 200 });
    expect(entry.usage).toEqual({ input: 5, output: 7 });
    expect(line).not.toContain("SECRET_PHI");
    expect(line).not.toContain("an answer");
  });
});

// W76 — the two ways a completion can be unusable while still being a 200 with a `content` array.
// Neither throws, neither is a network failure, and both used to reach the patient as an answer.
describe("/api/chat refuses an incomplete completion", () => {
  it("reports a max_tokens stop as an error rather than returning the fragment", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "Your ferritin has been trending down since Ma" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5, output_tokens: 4096 },
    });
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.errorCode).toBe("truncated");
    // The half-sentence must not be handed over under any key.
    expect(JSON.stringify(body)).not.toContain("ferritin");
  });

  it("reports a completion with no text block as an error rather than a blank answer", async () => {
    create.mockResolvedValue({ content: [], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 0 } });
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(502);
    expect((await res.json()).errorCode).toBe("empty_answer");
  });

  it("reports whitespace-only text the same way", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "  \n " }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    expect((await call({ auth: "valid" })).status).toBe(502);
  });

  it("still returns a complete answer", async () => {
    const res = await call({ auth: "valid" });
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ kind: "answer", answer: "an answer" });
  });
});
