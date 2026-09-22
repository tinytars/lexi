import { describe, it, expect, vi, beforeEach } from "vitest";

// Same SDK stub as chat-function.test.ts: the route calls messages.create once per attempt, so each
// attempt shows up as one createMock call and the ladder is countable.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { onRequestPost } from "../../functions/api/chat";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";

// REPORTS is unset, so no report is read here; a VAULT that throws on contact proves it.
const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { SESSION_SECRET: "test-secret", DB: fakeSessionDb(), VAULT: NO_STORAGE, STORE_PREFIX: "dev", ANTHROPIC_API_KEY: "k" };

const MSGS = [{ role: "user", content: "CONTEXT:\n{}\n\nQUESTION:\nwhich way is my iron heading?" }];

const answered = () => ({
  content: [{ type: "text", text: "It has risen over the last two draws." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 7 },
});

const busy = (status: number) => Object.assign(new Error("provider is busy"), { status });

async function ask() {
  return onRequestPost({
    request: new Request("http://local/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `hd_session=${await signSession(ENV, "acct-1")}` },
      body: JSON.stringify({ messages: MSGS, clientId: "alex" }),
    }),
    env: ENV,
  });
}

beforeEach(() => {
  createMock.mockReset();
});

// A busy provider is the question never having been asked, not an answer to it. Every other model
// route climbs a ladder over one (ranges-anthropic.ts, leaf-regen-anthropic.ts); this one asked once,
// so a single overloaded moment lost the patient's question and answered the browser a 5xx.
describe("functions/api/chat: a transient provider failure", () => {
  it("is retried, and the question is answered from the later attempt", async () => {
    createMock.mockRejectedValueOnce(busy(529)).mockResolvedValueOnce(answered());

    const res = await ask();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "answer" });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("is retried on a rate limit too, and gives up as ai_busy only once the ladder is exhausted", async () => {
    createMock.mockRejectedValue(busy(429));

    const res = await ask();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ errorCode: "ai_busy" });
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("leaves a failure that is not transient alone — no second billed call", async () => {
    createMock.mockRejectedValue(Object.assign(new Error("credit balance too low"), { status: 400 }));

    const res = await ask();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ errorCode: "insufficient_credit" });
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
