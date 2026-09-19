import { describe, it, expect, vi, beforeEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

import { onRequestPost } from "../../functions/api/persona-adapt";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";

const ENV = { SESSION_SECRET: "test-secret", DB: fakeSessionDb(), ANTHROPIC_API_KEY: "k" };
const LEXI = "• ApoB 92 mg/dL on 2026-07-21, up 3% since 2026-03-03.";

const reply = (text: string, stop_reason = "end_turn") => ({ content: [{ type: "text", text }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });

async function call(body: unknown, auth = true) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  return onRequestPost({ request: new Request("http://x/api/persona-adapt", { method: "POST", headers, body: JSON.stringify(body) }), env: ENV });
}

beforeEach(() => create.mockReset());

describe("/api/persona-adapt", () => {
  it("returns Kodi's restatement when every fact survives", async () => {
    const kodi = "Okay, your ApoB was 92 mg/dL on July 21, 2026 — up 3% since March 3, 2026.";
    create.mockResolvedValueOnce(reply(kodi));
    const res = await call({ persona: "kodi", text: LEXI });
    expect(await res.json()).toEqual({ kind: "adapted", persona: "kodi", text: kodi });
  });

  it("retries once naming the dropped facts, and accepts a faithful second try", async () => {
    create.mockResolvedValueOnce(reply("Your ApoB crept up a bit, babe."));
    create.mockResolvedValueOnce(reply("ApoB: 92 mg/dL on 2026-07-21, up 3% from 2026-03-03."));
    const res = await call({ persona: "kodi", text: LEXI });
    expect((await res.json() as { kind: string }).kind).toBe("adapted");
    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1][0].messages[0].content as string;
    for (const fact of ["92", "3", "2026-07-21", "2026-03-03"]) expect(retry.split("exactly as written: ")[1]).toContain(fact);
  });

  it("falls back to Lexi when the restatement keeps dropping facts", async () => {
    create.mockResolvedValue(reply("It went up a little."));
    const res = await call({ persona: "kodi", text: LEXI });
    expect(await res.json()).toEqual({ kind: "fallback" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("falls back on a truncated restatement rather than showing half of one", async () => {
    create.mockResolvedValueOnce(reply("ApoB 92 mg/dL on 2026-07-21, up 3% since 2026-03-03 and", "max_tokens"));
    expect(await (await call({ persona: "kodi", text: LEXI })).json()).toEqual({ kind: "fallback" });
  });

  it("never sends the adapter the record — only Lexi's answer", async () => {
    create.mockResolvedValueOnce(reply(LEXI));
    await call({ persona: "kodi", text: LEXI });
    const req = create.mock.calls[0][0];
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].content).toBe(`LEXI'S ANSWER:\n${LEXI}`);
    expect(req.tools).toBeUndefined();
  });

  it("rejects an unknown persona, empty text, and no session", async () => {
    expect((await call({ persona: "lexi", text: LEXI })).status).toBe(400);
    expect((await call({ persona: "kodi", text: " " })).status).toBe(400);
    expect((await call({ persona: "kodi", text: LEXI }, false)).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
});
