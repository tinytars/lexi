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

import type Anthropic from "@anthropic-ai/sdk";
import { onRequestPost } from "../../functions/api/chat";
import { signSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { CORPUS_ACK } from "../../functions/_lib/inference/corpus";
import { sealRaw } from "../../src/lib/raw-cipher";
import { bytesToBase64 } from "../../src/lib/base64";

const REPORT_PDF = new TextEncoder().encode("%PDF-1.4 report");
import { fakeSessionDb } from "../support/session-db";
import { useWorkerd } from "../support/miniflare";

// REPORTS is unset here, which is a deployment that never turned the corpus on — so a VAULT that
// throws on contact is the assertion that these cases read no storage at all.
const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { SESSION_SECRET: "test-secret",
    DB: fakeSessionDb(), VAULT: NO_STORAGE, STORE_PREFIX: "dev", ANTHROPIC_API_KEY: "k" };

const MSGS = [{ role: "user", content: "CONTEXT:\n{}\n\nQUESTION:\nwhat changed?" }];

async function call(opts: { auth?: "valid" | "bogus"; body?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth === "valid") headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  else if (opts.auth === "bogus") headers.cookie = "hd_session=bogus";
  return onRequestPost({
    request: new Request("http://local/api/chat", {
      method: "POST",
      headers,
      body: opts.body ?? JSON.stringify({ messages: MSGS, clientId: "alex" }),
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
    expect((await call({ auth: "valid", body: JSON.stringify({ messages: [], clientId: "alex" }) })).status).toBe(400);
    expect((await call({ auth: "valid", body: JSON.stringify({ messages: "nope", clientId: "alex" }) })).status).toBe(400);
    expect((await call({ auth: "valid", body: JSON.stringify({ messages: [{ role: "system", content: "x" }], clientId: "alex" }) })).status).toBe(400);
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
    const res = await call({ auth: "valid", body: JSON.stringify({ messages: imageMsgs, clientId: "alex" }) });
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ messages: imageMsgs }));
  });

  // W46 Phase 6 — raised from 512 KB to 8 MB so a turn carrying compressed-image base64 fits.
  it("413s only once the body exceeds the new 8 MB cap, not at the old 512 KB one", async () => {
    const bigButUnderCap = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1_000_000) }], clientId: "alex" });
    expect((await call({ auth: "valid", body: bigButUnderCap })).status).not.toBe(413);
    const overCap = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(9 * 1024 * 1024) }], clientId: "alex" });
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
    await call({ auth: "valid", body: JSON.stringify({ messages: MSGS, final: true, clientId: "alex" }) });
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
    await call({ auth: "valid", body: JSON.stringify({ messages: MSGS, unitSystem: "metric", clientId: "alex" }) });
    expect(systemOf()).toContain("SI units");
  });

  it("names US-conventional units when unitSystem=imperial (and on the default)", async () => {
    await call({ auth: "valid", body: JSON.stringify({ messages: MSGS, unitSystem: "imperial", clientId: "alex" }) });
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
        body: JSON.stringify({ messages: [{ role: "user", content: "SECRET_PHI in here" }], clientId: "alex" }),
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

// The requirement this whole change exists for: a question is answered in sight of the person's own
// reports. Real R2 and real D1 — what the corpus contains is a property of what storage holds.
describe("/api/chat answers in sight of the patient's reports", () => {
  const w = useWorkerd({ r2: true, perTest: true });
  const env = () =>
    ({ SESSION_SECRET: "test-secret", DB: w.db, VAULT: w.bucket, STORE_PREFIX: "dev", REPORTS: "always", ANTHROPIC_API_KEY: "k" }) as never;

  /** An account that owns `alex`, with one stored report. */
  async function alexWithAReport(): Promise<string> {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "alex", email: `alex-${id}@example.com` });
    const key = "dev/raw/alex/report.pdf";
    await w.bucket.put(key, new TextEncoder().encode("%PDF-1.4 report"));
    await recordRawObject(w.db, key, id, { pages: 2, bytes: 15 });
    return id;
  }

  /** The same account and the same report, stored the way the browser stores one: sealed. */
  async function alexWithASealedReport(contentKey: string): Promise<string> {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "alex", email: `alex-${id}@example.com` });
    const key = "dev/raw/alex/report.pdf";
    const sealed = await sealRaw(REPORT_PDF, contentKey);
    await w.bucket.put(key, sealed);
    await recordRawObject(w.db, key, id, { pages: 2, bytes: sealed.length });
    return id;
  }

  const post = async (accountId: string, body: unknown) =>
    onRequestPost({
      request: new Request("http://local/api/chat", {
        method: "POST",
        headers: { cookie: `hd_session=${await signSession(ENV, accountId)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env: env(),
    });

  const sentMessages = (round: number) => (create.mock.calls[round][0] as { messages: Anthropic.MessageParam[] }).messages;

  it("sends the reports ahead of the browser's own turns", async () => {
    const who = await alexWithAReport();

    const res = await post(who, { messages: MSGS, clientId: "alex" });

    expect(res.status).toBe(200);
    const messages = sentMessages(0);
    const first = messages[0].content as Anthropic.ContentBlockParam[];
    expect(first[0].type).toBe("document");
    expect(messages[1]).toEqual({ role: "assistant", content: CORPUS_ACK });
    expect(messages.slice(2)).toEqual(MSGS);
  });

  // The cache is keyed on the exact prefix bytes, so a corpus that differs by one byte between
  // round 1 and round 2 turns every tool round into a full re-write of the whole record.
  it("sends a byte-identical corpus on a tool round", async () => {
    const who = await alexWithAReport();
    const toolRound = [...MSGS, { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "get_marker_readings", input: {} }] }];

    await post(who, { messages: MSGS, clientId: "alex" });
    await post(who, { messages: toolRound, clientId: "alex" });

    expect(JSON.stringify(sentMessages(1).slice(0, 2))).toBe(JSON.stringify(sentMessages(0).slice(0, 2)));
  });

  // End to end on a sealed store: the key never touches the deployment's storage or config — it
  // arrives on the request, opens the document, and is gone when the request ends.
  it("opens a sealed report with the key the browser sent", async () => {
    const key = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
    const who = await alexWithASealedReport(key);

    const res = await post(who, { messages: MSGS, clientId: "alex", rawKeys: { "report.pdf": key } });

    expect(res.status).toBe(200);
    const first = sentMessages(0)[0].content as Anthropic.ContentBlockParam[];
    expect(first[0]).toMatchObject({ type: "document", source: { data: bytesToBase64(REPORT_PDF) } });
  });

  // 400 and a code of its own: nothing is wrong with the record, the request left out a key the
  // caller holds — and a classified refusal is what keeps the browser from filing it as a bug.
  it("400s a sealed report it was sent no key for, and calls no model", async () => {
    const who = await alexWithASealedReport(bytesToBase64(crypto.getRandomValues(new Uint8Array(32))));

    const res = await post(who, { messages: MSGS, clientId: "alex" });

    expect(res.status).toBe(400);
    expect((await res.json() as { errorCode: string }).errorCode).toBe("corpus_key_missing");
    expect(create).not.toHaveBeenCalled();
  });

  // A 403 would confirm the namespace exists; this route says only that there is nothing here.
  it("404s for an account that does not own the record, and calls no model", async () => {
    await alexWithAReport();
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "nobody", email: `nobody-${stranger}@example.com` });

    const res = await post(stranger, { messages: MSGS, clientId: "alex" });

    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  // The browser replays the array on every round; ~20 MB of base64 per round does not fit the body
  // cap once, and bytes the caller chose are not bytes the caller was authorised to read.
  it("400s on a caller-supplied document block rather than relaying it", async () => {
    const who = await alexWithAReport();
    const smuggled = [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
        { type: "text", text: "what does this say?" },
      ],
    }];

    const res = await post(who, { messages: smuggled, clientId: "alex" });

    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("client_document");
    expect(create).not.toHaveBeenCalled();
  });

  it("400s when the question does not say whose record it is about", async () => {
    const who = await alexWithAReport();

    const res = await post(who, { messages: MSGS });

    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe("no_client_id");
    expect(create).not.toHaveBeenCalled();
  });
});
