import { describe, it, expect, vi, beforeEach } from "vitest";

// The route's own reply, handed to the browser's API-failure reporter exactly as fetch would hand it
// over: a busy provider is a condition this app expects, so the reply carries an `errorCode` and the
// reporter must leave it alone rather than file it. Pinned end to end because the two halves live on
// opposite sides of the wire and each half's own test can only see its own half.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { onRequestPost } from "../../functions/api/chat";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";
import { installApiFailureReporting, installErrorReporter, type ClientErrorPayload } from "../../src/lib/error-reporter";

const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { SESSION_SECRET: "test-secret", DB: fakeSessionDb(), VAULT: NO_STORAGE, STORE_PREFIX: "dev", ANTHROPIC_API_KEY: "k" };
const MSGS = [{ role: "user", content: "CONTEXT:\n{}\n\nQUESTION:\nhow is my iron doing?" }];

beforeEach(() => {
  createMock.mockReset();
});

describe("a busy answer from /api/chat", () => {
  it("is not filed by the browser's API-failure reporter", async () => {
    createMock.mockImplementation(() => Promise.reject(Object.assign(new Error("provider is busy"), { status: 429 })));
    const filed: ClientErrorPayload[] = [];
    installErrorReporter(new EventTarget(), (p) => filed.push(p), () => {});

    const answer = await onRequestPost({
      request: new Request("http://local/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `hd_session=${await signSession(ENV, "acct-1")}` },
        body: JSON.stringify({ messages: MSGS, clientId: "alex" }),
      }),
      env: ENV,
    });
    expect(answer.status).toBe(503);

    const scope = { fetch: (async () => answer) as unknown as typeof fetch };
    installApiFailureReporting(scope, "https://lexitar.example");
    const seen = await scope.fetch("https://lexitar.example/api/chat", { method: "POST" });

    expect(filed).toEqual([]);
    // and the caller still reads the reason, so the panel can explain it
    expect(await seen.json()).toMatchObject({ errorCode: "ai_busy" });
  });
});
