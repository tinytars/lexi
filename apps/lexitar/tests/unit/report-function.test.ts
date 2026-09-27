import { describe, it, expect, vi, beforeEach } from "vitest";
import { onRequestPost } from "../../functions/api/report";
import { signSession } from "../../functions/_lib/session";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { useWorkerd } from "../support/miniflare";

// Real D1, per test: the hourly cap is the only thing between "report an account" and "accuse an
// account fifty times", and a fake that agreed with the route would not catch the cap being lifted.
// Per test because the cap is stateful — suites sharing one database would cap each other.
const w = useWorkerd({ perTest: true });

const REPORTER = "acct-1";
// A session for an account that does not exist is refused, which is the point of the revocation check.
beforeEach(async () => void (await createAccount(w.db, { id: REPORTER, displayName: "alex", email: "alex@example.com" })));

const GITHUB = { CLIENT_ERROR_GITHUB_TOKEN: "ghp_test", CLIENT_ERROR_GITHUB_REPO: "promontory-studio/plover-factory" };
const ISSUES = "https://api.github.com/repos/promontory-studio/plover-factory/issues";
const env = (extra: Record<string, unknown> = {}) => ({ SESSION_SECRET: "test-secret", DB: w.db, ...GITHUB, ...extra }) as Parameters<typeof onRequestPost>[0]["env"];

const post = async (e: ReturnType<typeof env>, body: unknown, opts: { authed?: boolean; ip?: string } = {}) => {
  const headers: Record<string, string> = { "cf-connecting-ip": opts.ip ?? "198.51.100.1" };
  if (opts.authed !== false) headers.cookie = `hd_session=${await signSession(e, REPORTER)}`;
  const request = new Request("https://lexitar.example/api/report", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return onRequestPost({ request, env: e });
};

// GitHub is the one boundary a test cannot hit for real.
const stubGithub = (openIssue: number | null, openLabels = ["safety-report"]) => {
  const calls: { url: string; method: string; body: { title: string; body: string; labels?: string[] } | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(url).includes("/issues?")) return Response.json(openIssue ? [{ number: openIssue, labels: openLabels.map((name) => ({ name })) }] : []);
    return new Response("{}", { status: 201 });
  });
  return calls;
};
const created = (calls: ReturnType<typeof stubGithub>) => calls.find((c) => c.method === "POST" && c.url === ISSUES)!;

describe("POST /api/report", () => {
  it.each(["misleading-answer", "illegal-content", "abusive-account"])("files a %s report under a label the autopilot never acts on", async (reason) => {
    const calls = stubGithub(null);

    const res = await post(env(), { reason, note: "this looks wrong" });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ filed: true, reference: expect.stringMatching(/^[0-9a-f]{8}$/) });
    // `safety-report`, never `client-error`: plover-factory's fixer keys on the latter, so a human
    // reads this one instead of a bot opening a patch for it.
    expect(created(calls).body!.labels).toEqual(["safety-report", `kind:${reason}`, expect.stringMatching(/^fp:/)]);
  });

  it("comments on the open issue when the same complaint comes in again", async () => {
    const calls = stubGithub(42, ["safety-report", "kind:abusive-account"]);

    expect((await post(env(), { reason: "abusive-account", subject: "acct-9" })).status).toBe(202);

    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`${ISSUES}/42/comments`]);
  });

  it("keeps two different complaints apart, so one user's report does not land on a stranger's issue", async () => {
    const first = stubGithub(null);
    await post(env(), { reason: "abusive-account", subject: "acct-9" });
    const second = stubGithub(null);
    await post(env(), { reason: "abusive-account", subject: "acct-77" });

    expect(created(second).body!.title).not.toBe(created(first).body!.title);
  });

  it("scrubs the reporter's own words, because someone describing a bad answer will quote it", async () => {
    const calls = stubGithub(null);

    await post(env(), { reason: "misleading-answer", subject: "msg-4", note: `it told "Jane Doe" her MRN 12345678 was fine — jane@example.com` });

    const filed = JSON.stringify(calls);
    for (const leak of ["Jane", "12345678", "jane@example.com"]) expect(filed).not.toContain(leak);
    expect(created(calls).body!.body).toContain(REPORTER);
  });

  // An id we generated or nothing: masking would hide that something else was sent.
  it("drops a subject that is not an id we issued", async () => {
    const calls = stubGithub(null);

    await post(env(), { reason: "misleading-answer", subject: "Jane Doe's glucose report" });

    expect(JSON.stringify(calls)).not.toContain("Jane");
  });

  it("stops one account flooding the tracker, once its hour is spent", async () => {
    stubGithub(null);
    for (let i = 0; i < 5; i++) expect((await post(env(), { reason: "abusive-account", subject: `acct-${i}` })).status).toBe(202);

    const res = await post(env(), { reason: "abusive-account", subject: "acct-6" });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ errorCode: "rate_limited" });
  });

  it("refuses a caller with no session — a crash report is worth taking from anyone, an accusation is not", async () => {
    const calls = stubGithub(null);

    expect((await post(env(), { reason: "abusive-account" }, { authed: false })).status).toBe(401);

    expect(calls).toEqual([]);
  });

  it("refuses a reason there is no obligation behind", async () => {
    const calls = stubGithub(null);

    const res = await post(env(), { reason: "i-dont-like-it" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errorCode: "bad_reason" });
    expect(calls).toEqual([]);
  });

  // A 202 here would be the worst possible answer: the user believes a human will read it.
  it("says reporting is unavailable rather than pretending to file, when no sink is configured", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(env({ CLIENT_ERROR_GITHUB_TOKEN: "", CLIENT_ERROR_GITHUB_REPO: "" }), { reason: "illegal-content" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ errorCode: "sink_unconfigured" });
    err.mockRestore();
  });

  it("tells the user when GitHub refuses the filing, instead of a quiet success", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post(env(), { reason: "illegal-content" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ errorCode: "sink_dead" });
    err.mockRestore();
  });
});
