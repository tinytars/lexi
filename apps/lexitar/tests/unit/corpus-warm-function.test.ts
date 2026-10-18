import { describe, it, expect, vi, beforeEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

import { onRequestPost } from "../../functions/api/corpus-warm";
import { signSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { chatSystemPrompt } from "../../src/lib/chat-prompt";
import { ModelUnsupportedError } from "../../functions/_lib/model-errors";
import { useWorkerd } from "../support/miniflare";

// What the platform returns for a zero-token budget: no content, and the usage that proves a write.
const WARMED = { content: [], stop_reason: "max_tokens", usage: { input_tokens: 8, output_tokens: 0, cache_creation_input_tokens: 5120, cache_read_input_tokens: 0 } };

describe("/api/corpus-warm", () => {
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

  const env = (reports: string) => ({ SESSION_SECRET: "test-secret", DB: w.db, ANTHROPIC_API_KEY: "k",
    VAULT: w.bucket, STORE_PREFIX: "dev", REPORTS: reports }) as never;

  const post = async (accountId: string | null, body: unknown, reports = "always") =>
    onRequestPost({
      request: new Request("http://x/api/corpus-warm", {
        method: "POST",
        headers: { "content-type": "application/json",
                   ...(accountId ? { cookie: `hd_session=${await signSession({ SESSION_SECRET: "test-secret" }, accountId)}` } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      env: env(reports),
    });

  it("reads the reports into the cache under the exact prompt chat will ask with", async () => {
    const who = await alexWithAReport();
    create.mockResolvedValueOnce(WARMED);

    const res = await post(who, { clientId: "alex", unitSystem: "metric" });

    expect(await res.json()).toEqual({ warmed: true, written: 5120, read: 0 });
    const req = create.mock.calls[0][0];
    expect(req.max_tokens).toBe(0);
    expect(req.system).toBe(chatSystemPrompt("metric"));
    expect(req.tools).toHaveLength(1);
    expect(req.stream).toBeUndefined();
    expect(req.messages[0].content[0].type).toBe("document");
  });

  // The breakpoint must stay on the last shared block — a cache entry keyed to the placeholder is
  // one chat never reads, and the write is billed either way.
  it("puts the placeholder after the cached prefix, not inside it", async () => {
    const who = await alexWithAReport();
    create.mockResolvedValueOnce(WARMED);

    await post(who, { clientId: "alex" });

    const messages = create.mock.calls[0][0].messages;
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("warmup");
    expect(last.content.cache_control).toBeUndefined();
    const docs = messages[0].content.filter((b: { type: string }) => b.type === "document");
    expect(docs[docs.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });

  // "off" and not "no_corpus": this record HAS a report, and the browser reads this one field to
  // decide whether an attached PDF still needs its transcription sent as text (CORPUS.md).
  it("says the deployment attaches no reports at all, and spends nothing", async () => {
    const who = await alexWithAReport();

    const res = await post(who, { clientId: "alex" }, "never");

    expect(await res.json()).toEqual({ warmed: false, reason: "off" });
    expect(create).not.toHaveBeenCalled();
  });

  it("spends nothing on a record that holds no reports yet", async () => {
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "new", email: `new-${id}@example.com` });

    const res = await post(id, { clientId: "new" });

    expect((await res.json() as { warmed: boolean }).warmed).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a namespace the session's account does not own, and an unsigned caller", async () => {
    await alexWithAReport();
    const stranger = crypto.randomUUID();
    await createAccount(w.db, { id: stranger, displayName: "nobody", email: `nobody-${stranger}@example.com` });

    expect((await post(stranger, { clientId: "alex" })).status).toBe(404);
    expect((await post(null, { clientId: "alex" })).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  // W86 — a pre-warm is fire-and-forget: the browser reads `warmed` and nothing else, and a cold
  // cache is a slower first answer, never a wrong one. A 5xx here was a red request in the console
  // and a candidate for the browser's own 5xx reporter, for an outcome the app is built to tolerate.
  it("answers 200 warmed:false when the provider is busy, like its other refusals", async () => {
    const who = await alexWithAReport();
    create.mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }));

    const res = await post(who, { clientId: "alex" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ warmed: false, reason: "failed", errorCode: "ai_busy" });
  });

  // A 4xx is a verdict on the CALLER, not on the moment — softening it would hide it.
  it("keeps a 4xx status, so a model that cannot take PDFs still says so", async () => {
    const who = await alexWithAReport();
    create.mockRejectedValueOnce(new ModelUnsupportedError("PDF documents"));

    const res = await post(who, { clientId: "alex" });

    expect(res.status).toBe(422);
    expect((await res.json() as { errorCode: string }).errorCode).toBe("model_unsupported");
  });

  it("400s without a clientId", async () => {
    const who = await alexWithAReport();

    const res = await post(who, {});

    expect(res.status).toBe(400);
    expect((await res.json() as { errorCode: string }).errorCode).toBe("no_client_id");
    expect(create).not.toHaveBeenCalled();
  });
});
