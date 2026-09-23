import { describe, it, expect, vi } from "vitest";
import { onRequestPost } from "../../functions/api/client-error";
import { scrubMessage, scrubFrames, toReport } from "../../functions/_lib/client-error";
import { signSession } from "../../functions/_lib/session";
import { fakeSessionDb } from "../support/session-db";
import { useWorkerd } from "../support/miniflare";

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
  const github = { CLIENT_ERROR_GITHUB_TOKEN: "ghp_test", CLIENT_ERROR_GITHUB_REPO: "promontory-studio/plover-factory" };
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
  const stubGithub = (openIssue: number | null, openLabels: string[] = ["client-error"]) => {
    const calls: { url: string; method: string; body: { title: string; body: string; labels?: string[] } | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/issues?")) return Response.json(openIssue ? [{ number: openIssue, labels: openLabels.map((name) => ({ name })) }] : []);
      return new Response("{}", { status: 201 });
    });
    return calls;
  };
  it("opens an issue for a first occurrence, titled with name and fingerprint but no message", async () => {
    const calls = stubGithub(null);
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.url).toBe("https://api.github.com/repos/promontory-studio/plover-factory/issues");
    expect(create.body!.title).toMatch(/^Client error: Error \[[0-9a-f]{8}\]$/);
    expect(create.body!.body).toContain("each_key_duplicate");
    const fp = /\[([0-9a-f]{8})\]$/.exec(create.body!.title)![1];
    expect(create.body!.labels).toEqual(["client-error", `fp:${fp}`]);
    expect(calls[0].url).toContain(`labels=fp%3A${fp}`);
    expect(create.body!.body).toContain("s (/assets/index-DYIIhPYC.js:393:101240)");
    expect(create.body!.body).toContain("lexitar.example");
  });

  it("comments on the open issue for a recurrence instead of opening a duplicate", async () => {
    const calls = stubGithub(42);
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    const writes = calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.url)).toEqual(["https://api.github.com/repos/promontory-studio/plover-factory/issues/42/comments"]);
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

  // A crash first seen logged-out opens a pre-auth issue; without this the authenticated recurrence
  // only comments and the issue never gains the label that gates promotion and wakes the autopilot.
  it("promotes a pre-auth issue to client-error when the same crash recurs for a signed-in user", async () => {
    const calls = stubGithub(42, ["pre-auth"]);
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    const writes = calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/promontory-studio/plover-factory/issues/42/labels",
      "https://api.github.com/repos/promontory-studio/plover-factory/issues/42/comments",
    ]);
    expect(writes[0].body).toEqual({ labels: ["client-error"] });
  });

  // W86 — one isolate killed for memory answers 503 on whichever routes were in flight, and each
  // arrives here as a separately-fingerprinted "client bug". The second label is what stops the
  // autopilot opening a fix attempt against code that has no defect in it; the source label stays,
  // because the promotion gate must still hold a build whose deployment is doing this.
  it("labels a 5xx the platform answered, so the autopilot leaves it alone", async () => {
    const calls = stubGithub(null);

    await post({ ...baseEnv(), ...github }, { name: "PlatformUnavailable", message: "POST /api/leaf-regen → 503", stack: "" });

    const create = calls.find((c) => c.method === "POST")!;
    expect(create.body!.labels!.slice(0, 2)).toEqual(["client-error", "platform-5xx"]);
  });

  it("leaves an application error unlabelled as platform, so it still reaches the autopilot", async () => {
    const calls = stubGithub(null);

    await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE);

    expect(calls.find((c) => c.method === "POST")!.body!.labels).not.toContain("platform-5xx");
  });

  // An earlier occurrence opened the issue before this label existed, or opened it pre-auth.
  it("back-fills the platform label onto an issue already open for the same fingerprint", async () => {
    const calls = stubGithub(42, ["client-error"]);

    await post({ ...baseEnv(), ...github }, { name: "PlatformUnavailable", message: "POST /api/chat → 503", stack: "" });

    const writes = calls.filter((c) => c.method === "POST");
    expect(writes[0].url).toBe("https://api.github.com/repos/promontory-studio/plover-factory/issues/42/labels");
    expect(writes[0].body).toEqual({ labels: ["platform-5xx"] });
  });

  // fakeSessionDb throws on any query but the session lookup, so a budget write on this path would
  // make spendReportBudget fail closed and this report would never be filed.
  it("spends no report budget for a signed-in caller, so an anonymous flood cannot starve a real crash", async () => {
    const calls = stubGithub(null);
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    expect(calls.some((c) => c.url.endsWith("/issues"))).toBe(true);
  });

  // A refused token used to be indistinguishable from a healthy quiet week: the client is answered
  // 204 either way and nothing reaches the tracker.
  it("still answers 204 when GitHub refuses the token, but says so in the log", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(String(l)));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    expect(lines.some((l) => l.includes("github_dead"))).toBe(true);
    log.mockRestore();
    err.mockRestore();
  });

  it("retries a GitHub blip once, since a 503 a moment later is usually a 201", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      if (calls === 1) return new Response("{}", { status: 503 });
      if (String(url).includes("/issues?")) return Response.json([]);
      return new Response("{}", { status: 201 });
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post({ ...baseEnv(), ...github }, EACH_KEY_DUPLICATE)).status).toBe(204);
    expect(calls).toBe(3);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  describe("without a session", () => {
    // A fresh D1 per test: the budget also has a global hourly cap, which tests sharing one database
    // would spend on each other.
    const d1 = useWorkerd({ perTest: true });
    const anon = (ip: string, body: unknown, headers: Record<string, string> = {}) =>
      onRequestPost({
        request: new Request("https://lexitar.example/api/client-error", {
          method: "POST",
          headers: { origin: "https://lexitar.example", "cf-connecting-ip": ip, "user-agent": "test-agent", ...headers },
          body: JSON.stringify(body),
        }),
        env: { SESSION_SECRET: "test-secret", DB: d1.db, ...github } as Parameters<typeof onRequestPost>[0]["env"],
      });

    // The case the session gate never saw: a tab whose bundle is too stale to boot has no session.
    it("accepts a same-origin report and files it under pre-auth, which gates nothing", async () => {
      const calls = stubGithub(null);
      expect((await anon("198.51.100.10", EACH_KEY_DUPLICATE)).status).toBe(204);
      const create = calls.find((c) => c.method === "POST")!;
      expect(create.url).toBe("https://api.github.com/repos/promontory-studio/plover-factory/issues");
      expect(create.body!.labels![0]).toBe("pre-auth");
    });

    it("refuses a report claiming another origin", async () => {
      const calls = stubGithub(null);
      expect((await anon("198.51.100.11", EACH_KEY_DUPLICATE, { origin: "https://evil.example" })).status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("scrubs an anonymous report exactly like a signed-in one", async () => {
      const calls = stubGithub(null);
      await anon("198.51.100.12", { name: "TypeError", message: `bad value for "Jane Doe"`, stack: "" });
      expect(JSON.stringify(calls)).not.toContain("Jane");
    });

    it("stops filing once an address has spent its hour, and still answers 204", async () => {
      const calls = stubGithub(null);
      for (let i = 0; i < 5; i++) expect((await anon("198.51.100.13", EACH_KEY_DUPLICATE)).status, `report ${i + 1}`).toBe(204);
      expect(calls.filter((c) => c.url.endsWith("/issues"))).toHaveLength(5);
      expect((await anon("198.51.100.13", EACH_KEY_DUPLICATE)).status).toBe(204);
      expect(calls.filter((c) => c.url.endsWith("/issues"))).toHaveLength(5);
    });

    it("charges a report naming none of our own assets most of the hour", async () => {
      const calls = stubGithub(null);
      const extension = { name: "Error", message: "extension blew up", stack: "at f (chrome-extension://abc/x.js:1:1)" };
      expect((await anon("198.51.100.14", extension)).status).toBe(204);
      expect((await anon("198.51.100.14", extension)).status).toBe(204);
      expect(calls.filter((c) => c.url.endsWith("/issues"))).toHaveLength(1);
    });

    it("takes the boot guard's report, whose stack is empty by construction, at the cheap rate", async () => {
      const calls = stubGithub(null);
      const boot = { name: "StaleBuildError", message: "Failed to load https://lexitar.example/assets/index-A.js", stack: "", build: "", source: "boot-asset" };
      for (let i = 0; i < 2; i++) expect((await anon("198.51.100.16", boot)).status).toBe(204);
      expect(calls.filter((c) => c.url.endsWith("/issues"))).toHaveLength(2);
    });
  });
});
