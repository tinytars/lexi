import { describe, it, expect, vi, beforeEach } from "vitest";
import { onRequest } from "../../functions/api/_middleware";
import { resetServerErrorDedupe, routePatternFor, toServerReport } from "../../functions/_lib/server-error";
import { ROUTE_PATTERNS } from "../../functions/_lib/route-patterns";

// A thrown D1/R2 error used to be an unreported 500 — a 1101 on a dashboard nobody opens.

const github = { CLIENT_ERROR_GITHUB_TOKEN: "ghp_test", CLIENT_ERROR_GITHUB_REPO: "promontory-studio/plover-factory" };

// `openLabels` is not decoration: a real open issue already carries the label it was created with,
// and `fileReport` adds only the ones missing. A stub that answered with no labels would make every
// recurrence look like it needed promoting.
const stubGithub = (openIssue: number | null, openLabels: string[] = ["server-error"]) => {
  const calls: { url: string; method: string; body: { title?: string; body?: string; labels?: string[] } | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/issues?"))
      return Response.json(openIssue ? [{ number: openIssue, labels: openLabels.map((name) => ({ name })) }] : []);
    return new Response("{}", { status: 201 });
  });
  return calls;
};

async function run(pathname: string, error: unknown, env: Record<string, unknown> = github) {
  const tasks: Promise<unknown>[] = [];
  const request = new Request(`https://lexitar.example${pathname}`, { method: "POST", headers: { "cf-ray": "abc123-SJC" } });
  const response = await onRequest({
    request,
    env: env as never,
    next: () => Promise.reject(error),
    waitUntil: (p) => void tasks.push(p),
  });
  await Promise.all(tasks);
  return response;
}

describe("route patterns", () => {
  it("names the pattern a live pathname belongs to, never the pathname", () => {
    expect(routePatternFor("/api/vault/alex-labs-2025")).toBe("/api/vault/:id");
    expect(routePatternFor("/api/raw/alex/labs-2025.pdf")).toBe("/api/raw/:path*");
    expect(routePatternFor("/api/chat")).toBe("/api/chat");
    expect(routePatternFor("/api/nothing-claims-this")).toBeNull();
  });

  it("covers every route the functions tree defines", () => {
    expect(ROUTE_PATTERNS).toContain("/api/client-error");
    expect(ROUTE_PATTERNS.every((p) => p.startsWith("/api/"))).toBe(true);
  });
});

describe("functions/api/_middleware", () => {
  beforeEach(() => resetServerErrorDedupe());

  it("turns a thrown D1 error into one issue, naming the route pattern", async () => {
    const calls = stubGithub(null);
    const res = await run("/api/vault/alex-labs-2025", new Error("D1_ERROR: no such table: vault_envelopes"));

    expect(res.status).toBe(500);
    // The errorCode is not decoration: reportServerError has just filed this event as a
    // `server-error`, and this is what stops the browser's installApiFailureReporting filing it a
    // second time as a promotion-gating `client-error`.
    expect(await res.json()).toEqual({ error: "internal error", errorCode: "unhandled" });
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.url).toBe("https://api.github.com/repos/promontory-studio/plover-factory/issues");
    expect(create.body!.title).toMatch(/^Server error: \/api\/vault\/:id — Error \[[0-9a-f]{8}\]$/);
    expect(create.body!.labels![0]).toBe("server-error");
    expect(create.body!.body).toContain("no such table");
    expect(create.body!.body).toContain("POST /api/vault/:id");
  });

  it("never carries the live pathname, which names a patient and a document", async () => {
    const calls = stubGithub(null);
    await run("/api/raw/alex/labs-2025.pdf", new Error("R2 get failed for prod/raw/alex/labs-2025.pdf"));
    const sent = JSON.stringify(calls);
    for (const leak of ["alex", "labs-2025"]) expect(sent).not.toContain(leak);
    expect(calls.find((c) => c.method === "POST")!.body!.body).toContain("/api/raw/:path*");
  });

  it("reports an inference route by classified code only — a vendor error can quote the patient", async () => {
    const calls = stubGithub(null);
    const vendor = Object.assign(new Error(`400 invalid_request: could not process "my mother's biopsy results"`), { status: 400 });
    await run("/api/chat", vendor);
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain("biopsy");
    expect(sent).not.toContain("mother");
    expect(calls.find((c) => c.method === "POST")!.body!.body).toContain("model_error (Error)");
  });

  it("comments on a recurrence from another isolate instead of opening a duplicate", async () => {
    const calls = stubGithub(77);
    await run("/api/chat-history/t91", new Error("D1_ERROR: database is locked"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "https://api.github.com/repos/promontory-studio/plover-factory/issues/77/comments",
    ]);
  });

  it("files the same failure once per isolate, however many requests hit it", async () => {
    const calls = stubGithub(null);
    await run("/api/vault/a", new Error("D1_ERROR: no such table: vault_envelopes"));
    await run("/api/vault/b", new Error("D1_ERROR: no such table: vault_envelopes"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("still answers 500, and logs, when no GitHub sink is configured", async () => {
    const calls = stubGithub(null);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await run("/api/chat", new Error("boom"), {})).status).toBe(500);
    expect(calls).toEqual([]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("passes a successful response through untouched", async () => {
    stubGithub(null);
    const ok = new Response("static", { status: 200 });
    const res = await onRequest({
      request: new Request("https://lexitar.example/api/unclaimed"),
      env: github as never,
      next: () => Promise.resolve(ok),
      waitUntil: () => {},
    });
    expect(res).toBe(ok);
  });

  it("does not report a 500 the handler built itself — that failure is already classified", async () => {
    const calls = stubGithub(null);
    const own = new Response(JSON.stringify({ error: "model busy" }), { status: 503 });
    await onRequest({
      request: new Request("https://lexitar.example/api/chat"),
      env: github as never,
      next: () => Promise.resolve(own),
      waitUntil: () => {},
    });
    expect(calls).toEqual([]);
  });
});

describe("server report scrubbing", () => {
  const ctx = { route: "/api/vault/:id", method: "PUT", deployment: "lexitar.example" };

  it("masks an R2 key's patient slug and filename, keeping the static route segments", async () => {
    const r = await toServerReport(new Error("put failed: prod/raw/alex/labs-2025.pdf"), ctx);
    expect(r.message).not.toContain("alex");
    expect(r.message).not.toContain("labs-2025");
    expect(r.message).toContain("raw");
  });

  it("masks a token that leaked into a message", async () => {
    const r = await toServerReport(new Error("auth failed for ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), ctx);
    expect(r.message).not.toContain("ABCDEFGH");
    expect(r.message).toContain("<token>");
  });

  it("fingerprints by route, so the same message on two routes is two bugs", async () => {
    const a = await toServerReport(new Error("D1_ERROR: database is locked"), ctx);
    const b = await toServerReport(new Error("D1_ERROR: database is locked"), { ...ctx, route: "/api/chat-history/:id" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("keeps a server stack, whose frames have no leading slash", async () => {
    const e = new Error("boom");
    e.stack = "Error: boom\n    at onRequestPut (index.js:1234:56)\n    at async run (index.js:99:1)";
    expect((await toServerReport(e, ctx)).frames).toEqual(["onRequestPut (index.js:1234:56)", "run (index.js:99:1)"]);
  });
});
