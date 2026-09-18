import { describe, it, expect, afterEach, vi } from "vitest";
import { onRequestPost } from "../../functions/api/client-error";
import { scrubMessage, scrubFrames, toReport } from "../../functions/_lib/client-error";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "./_session-db";

// The crash that prompted the reporter: it existed only in one browser console, never in the tracker.
const EACH_KEY_DUPLICATE = {
  name: "Error",
  message: "https://svelte.dev/e/each_key_duplicate",
  stack: [
    "Error: https://svelte.dev/e/each_key_duplicate",
    "    at Ne (https://lexitar.example/assets/index-DYIIhPYC.js:2:3283)",
    "    at https://lexitar.example/assets/index-DYIIhPYC.js:2:37278",
    "    at gi (https://lexitar.example/assets/index-DYIIhPYC.js:2:36842)",
    "    at s (https://lexitar.example/assets/index-DYIIhPYC.js:393:101240)",
  ].join("\n"),
};

describe("client error scrubbing", () => {
  it("keeps a Svelte error code intact — it is the whole diagnosis", () => {
    expect(scrubMessage(EACH_KEY_DUPLICATE.message)).toBe("https://svelte.dev/e/each_key_duplicate");
  });

  it("masks anything the app may have interpolated about the patient", () => {
    const out = scrubMessage(`"Jane Doe glucose.pdf" is 250 pages — mail jane@example.com, MRN 12345678, see https://host/c/jane`);
    for (const leak of ["Jane", "glucose", "jane@example.com", "12345678", "/c/jane"]) expect(out).not.toContain(leak);
    expect(out).toContain("pages");
  });

  it("reduces the stack to function names and bundle positions, dropping the origin", () => {
    expect(scrubFrames(EACH_KEY_DUPLICATE.stack)).toEqual([
      "Ne (/assets/index-DYIIhPYC.js:2:3283)",
      "/assets/index-DYIIhPYC.js:2:37278",
      "gi (/assets/index-DYIIhPYC.js:2:36842)",
      "s (/assets/index-DYIIhPYC.js:393:101240)",
    ]);
  });

  it("reads Firefox/Safari frames too", () => {
    expect(scrubFrames("Ne@https://h/assets/index-A.js:2:10\n@https://h/assets/index-A.js:3:4")).toEqual([
      "Ne (/assets/index-A.js:2:10)",
      "/assets/index-A.js:3:4",
    ]);
  });

  it("fingerprints by error, not by build — the same crash on a new deploy is the same issue", async () => {
    const a = await toReport(EACH_KEY_DUPLICATE);
    const b = await toReport({ ...EACH_KEY_DUPLICATE, stack: EACH_KEY_DUPLICATE.stack.replaceAll("DYIIhPYC", "DbH4t27u") });
    const other = await toReport({ ...EACH_KEY_DUPLICATE, message: "https://svelte.dev/e/effect_update_depth_exceeded" });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(other.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("POST /api/client-error", () => {
  const github = { CLIENT_ERROR_GITHUB_TOKEN: "ghp_test", CLIENT_ERROR_GITHUB_REPO: "pablo-tech/plover-factory" };
  const baseEnv = () => ({ SESSION_SECRET: "test-secret", DB: fakeSessionDb() });
  const post = async (env: Parameters<typeof onRequestPost>[0]["env"], body: unknown, authed = true) => {
    const cookie = authed ? `hd_session=${await signSession(env, "acct-1")}` : "";
    const request = new Request("https://lexitar.example/api/client-error", {
      method: "POST",
      headers: { cookie, "user-agent": "test-agent" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return onRequestPost({ request, env });
  };

  // GitHub is the one boundary a test cannot hit for real.
  const stubGithub = (openIssue: number | null) => {
    const calls: { url: string; method: string; body: Record<string, string> | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/search/issues")) return Response.json({ items: openIssue ? [{ number: openIssue }] : [] });
      return new Response("{}", { status: 201 });
    });
    return calls;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a caller without a session, so the public URL cannot spam the tracker", async () => {
    const calls = stubGithub(null);
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE, false)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("opens an issue for a first occurrence, titled with name and fingerprint but no message", async () => {
    const calls = stubGithub(null);
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.url).toBe("https://api.github.com/repos/pablo-tech/plover-factory/issues");
    expect(create.body!.title).toMatch(/^Client error: Error \[[0-9a-f]{8}\]$/);
    expect(create.body!.body).toContain("each_key_duplicate");
    expect(create.body!.body).toContain("s (/assets/index-DYIIhPYC.js:393:101240)");
    expect(create.body!.body).toContain("lexitar.example");
  });

  it("comments on the open issue for a recurrence instead of opening a duplicate", async () => {
    const calls = stubGithub(42);
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    const writes = calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.url)).toEqual(["https://api.github.com/repos/pablo-tech/plover-factory/issues/42/comments"]);
  });

  it("never sends the raw message to GitHub", async () => {
    const calls = stubGithub(null);
    await post({ ...baseEnv(), ...github }, { name: "TypeError", message: `bad value for "Jane Doe"`, stack: "" });
    expect(JSON.stringify(calls)).not.toContain("Jane");
  });

  it("links the build's commit, and drops a build that isn't a SHA", async () => {
    const calls = stubGithub(null);
    await post({ ...baseEnv(), ...github }, { ...EACH_KEY_DUPLICATE, build: "c609e8a1b2" });
    expect(calls.find((c) => c.method === "POST")!.body!.body).toContain("- Build: tinytars/lexi@c609e8a1b2");
    const junk = stubGithub(null);
    await post({ ...baseEnv(), ...github }, { ...EACH_KEY_DUPLICATE, build: "Jane Doe" });
    const body = junk.find((c) => c.method === "POST")!.body!.body;
    expect(body).toContain("- Build: unknown");
    expect(body).not.toContain("Jane");
  });

  it("still 204s, filing nothing, when no GitHub sink is configured", async () => {
    const calls = stubGithub(null);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(baseEnv(), EACH_KEY_DUPLICATE)).status).toBe(204);
    expect(calls).toEqual([]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("rejects malformed and oversized bodies", async () => {
    stubGithub(null);
    expect((await post({ ...baseEnv(), ...github }, "{not json")).status).toBe(400);
    expect((await post({ ...baseEnv(), ...github }, { message: "x".repeat(20_000) })).status).toBe(413);
  });
});
