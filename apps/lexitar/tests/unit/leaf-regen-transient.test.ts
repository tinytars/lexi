import { describe, it, expect, vi, beforeEach } from "vitest";

// Same SDK stub as leaf-regen-function.test.ts: runLeafRegen streams, but it reads one final
// message, so the mock stays a plain promise and every attempt shows up as one createMock call.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: (...args: unknown[]) => ({ finalMessage: () => createMock(...args) }) };
  },
}));

import { onRequestPost } from "../../functions/api/leaf-regen";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";

// REPORTS is unset, so nothing here reads a report; a VAULT that throws on contact proves it.
const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { ANTHROPIC_API_KEY: "k", SESSION_SECRET: "test-secret", DB: fakeSessionDb(),
    VAULT: NO_STORAGE, STORE_PREFIX: "dev" };

const INPUTS = { pursuedStudy: { entries: [{ focus: "sleep study", detail: "home test booked" }] } };

const answered = () => ({
  content: [{ type: "tool_use", name: "emit_study_results", input: { items: [{ study: "sleep study", result: "home test booked", group: "sleep" }] } }],
  usage: { input_tokens: 3, output_tokens: 4 },
});

const busy = (status: number) => Object.assign(new Error("provider is busy"), { status });

async function call() {
  return onRequestPost({
    request: new Request("http://x/api/leaf-regen", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `hd_session=${await signSession(ENV, "acct-1")}` },
      body: JSON.stringify({ clientId: "alex", node: "studyResults", inputs: INPUTS }),
    }),
    env: ENV,
  });
}

const bodyJson = async (res: Response) => JSON.parse(await res.text());

// A busy provider is the request never having been asked, not an answer to it. `generateRange`
// (ranges-anthropic.ts) has climbed a ladder over these since the CLI and the Function were merged,
// for the reason its header names — one 429 used to mark a marker permanently failed. The leaf path
// is the busiest model call in the app and had no ladder at all, so a single overloaded moment lost
// the patient's Translate and reached the browser as a 5xx.
beforeEach(() => {
  createMock.mockReset();
});

describe("functions/api/leaf-regen: a transient provider failure", () => {
  it("is retried, and the leaf is answered from the later attempt", async () => {
    createMock.mockRejectedValueOnce(busy(529)).mockResolvedValueOnce(answered());

    const res = await call();

    expect(res.status).toBe(200);
    expect((await bodyJson(res)).result).toMatchObject({ items: [{ study: "sleep study" }] });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("is retried on a rate limit too, and gives up as ai_busy only once the ladder is exhausted", async () => {
    createMock.mockRejectedValue(busy(429));

    const res = await call();

    expect(res.status).toBe(503);
    expect((await bodyJson(res)).errorCode).toBe("ai_busy");
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("leaves a failure that is not transient alone — no second billed call", async () => {
    createMock.mockRejectedValue(Object.assign(new Error("credit balance too low"), { status: 400 }));

    const res = await call();

    expect(res.status).toBe(402);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
