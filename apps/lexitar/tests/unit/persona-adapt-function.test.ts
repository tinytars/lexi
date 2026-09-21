import { describe, it, expect, vi, beforeEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

import { onRequestPost } from "../../functions/api/persona-adapt";
import { signSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { CORPUS_ACK } from "../../functions/_lib/inference/corpus";
import { fakeSessionDb } from "../support/session-db";
import { useWorkerd } from "../support/miniflare";

// REPORTS unset — the corpus off — and a VAULT that throws on contact to prove it stays off.
const NO_STORAGE = new Proxy({}, { get: () => () => { throw new Error("touched storage"); } }) as never;
const ENV = { SESSION_SECRET: "test-secret", DB: fakeSessionDb(), ANTHROPIC_API_KEY: "k",
    VAULT: NO_STORAGE, STORE_PREFIX: "dev" };
const LEXI = "• ApoB 92 mg/dL on 2026-07-21, up 3% since 2026-03-03.";

const reply = (text: string, stop_reason = "end_turn") => ({ content: [{ type: "text", text }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });

async function call(body: unknown, auth = true) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.cookie = `hd_session=${await signSession(ENV, "acct-1")}`;
  // Whose record this is, required on every call — these cases are about the adapter's other
  // contracts, so the id is filled in here rather than repeated in every body.
  const payload = typeof body === "string" ? body : JSON.stringify({ clientId: "alex", ...(body as object) });
  return onRequestPost({ request: new Request("http://x/api/persona-adapt", { method: "POST", headers, body: payload }), env: ENV });
}

beforeEach(() => create.mockReset());

describe("/api/persona-adapt", () => {
  it("returns Cody's restatement when every fact survives", async () => {
    const cody = "Okay, your ApoB was 92 mg/dL on July 21, 2026 — up 3% since March 3, 2026.";
    create.mockResolvedValueOnce(reply(cody));
    const res = await call({ persona: "cody", text: LEXI });
    expect(await res.json()).toEqual({ kind: "adapted", persona: "cody", text: cody });
  });

  it("retries once naming the dropped facts, and accepts a faithful second try", async () => {
    create.mockResolvedValueOnce(reply("Your ApoB crept up a bit, babe."));
    create.mockResolvedValueOnce(reply("ApoB: 92 mg/dL on 2026-07-21, up 3% from 2026-03-03."));
    const res = await call({ persona: "cody", text: LEXI });
    expect((await res.json() as { kind: string }).kind).toBe("adapted");
    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1][0].messages[0].content as string;
    for (const fact of ["92", "3", "2026-07-21", "2026-03-03"]) expect(retry.split("exactly as written: ")[1]).toContain(fact);
  });

  it("falls back to Lexi when the restatement keeps dropping facts", async () => {
    create.mockResolvedValue(reply("It went up a little."));
    const res = await call({ persona: "cody", text: LEXI });
    expect(await res.json()).toEqual({ kind: "fallback" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("falls back on a truncated restatement rather than showing half of one", async () => {
    create.mockResolvedValueOnce(reply("ApoB 92 mg/dL on 2026-07-21, up 3% since 2026-03-03 and", "max_tokens"));
    expect(await (await call({ persona: "cody", text: LEXI })).json()).toEqual({ kind: "fallback" });
  });

  // With the corpus off this route sends Lexi's answer and nothing else. When it is on the reports
  // lead (see the corpus describe below) — what never changes is that the ANSWER turn is the whole
  // of what Cody is asked to restate, with no record spliced into it.
  it("sends only Lexi's answer when the corpus is off", async () => {
    create.mockResolvedValueOnce(reply(LEXI));
    await call({ persona: "cody", text: LEXI });
    const req = create.mock.calls[0][0];
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].content).toBe(`THE ANSWER:\n${LEXI}`);
    expect(req.tools).toBeUndefined();
  });

  it("hands Cody the patient's question to listen to, ahead of the answer", async () => {
    create.mockResolvedValueOnce(reply(LEXI));
    await call({ persona: "cody", text: LEXI, question: "  is my ApoB getting worse? I'm scared  " });
    expect(create.mock.calls[0][0].messages[0].content).toBe(`THE PATIENT ASKED:\nis my ApoB getting worse? I'm scared\n\nTHE ANSWER:\n${LEXI}`);
  });

  it("still answers a tab opened before the rename, which asks for Kodi", async () => {
    create.mockResolvedValueOnce(reply(LEXI));
    expect(await (await call({ persona: "kodi", text: LEXI })).json()).toEqual({ kind: "adapted", persona: "cody", text: LEXI });
  });

  it("rejects a question that is not text or is oversized", async () => {
    expect((await call({ persona: "cody", text: LEXI, question: 7 })).status).toBe(400);
    expect((await call({ persona: "cody", text: LEXI, question: "x".repeat(8 * 1024 + 1) })).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unknown persona, empty text, and no session", async () => {
    expect((await call({ persona: "lexi", text: LEXI })).status).toBe(400);
    expect((await call({ persona: "cody", text: " " })).status).toBe(400);
    expect((await call("{not json")).status).toBe(400);
    expect((await call({ persona: "cody", text: LEXI }, false)).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("/api/persona-adapt restates in sight of the patient's reports", () => {
  const w = useWorkerd({ r2: true, perTest: true });
  beforeEach(() => create.mockReset());

  async function alexWithAReport(): Promise<string> {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "alex", email: `alex-${id}@example.com` });
    const key = "dev/raw/alex/report.pdf";
    await w.bucket.put(key, new TextEncoder().encode("%PDF-1.4 report"));
    await recordRawObject(w.db, key, id, { pages: 2, bytes: 15 });
    return id;
  }

  const post = async (accountId: string, body: unknown) =>
    onRequestPost({
      request: new Request("http://x/api/persona-adapt", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `hd_session=${await signSession(ENV, accountId)}` },
        body: JSON.stringify(body),
      }),
      env: { SESSION_SECRET: "test-secret", DB: w.db, ANTHROPIC_API_KEY: "k", VAULT: w.bucket,
             STORE_PREFIX: "dev", REPORTS: "always" } as never,
    });

  it("leads with the reports, ahead of the answer to restate", async () => {
    const who = await alexWithAReport();
    create.mockResolvedValueOnce(reply(LEXI));

    await post(who, { persona: "cody", clientId: "alex", text: LEXI });

    const messages = create.mock.calls[0][0].messages;
    expect(messages[0].content[0].type).toBe("document");
    expect(messages[1]).toEqual({ role: "assistant", content: CORPUS_ACK });
    expect(messages[2].content).toBe(`THE ANSWER:\n${LEXI}`);
  });

  it("400s without a clientId, and calls no model", async () => {
    const who = await alexWithAReport();

    const res = await post(who, { persona: "cody", text: LEXI });

    expect(res.status).toBe(400);
    expect((await res.json() as { errorCode: string }).errorCode).toBe("no_client_id");
    expect(create).not.toHaveBeenCalled();
  });

  it("404s on a namespace the session's account does not own", async () => {
    await alexWithAReport();
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "nobody", email: `nobody-${stranger}@example.com` });

    const res = await post(stranger, { persona: "cody", clientId: "alex", text: LEXI });

    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });
});
