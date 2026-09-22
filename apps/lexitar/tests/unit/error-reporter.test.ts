import { describe, it, expect, vi, afterEach } from "vitest";
import { installApiFailureReporting, installErrorReporter, reportCaughtError, type ClientErrorPayload } from "../../src/lib/error-reporter";
import { lazyImport } from "../../src/lib/lazy-import";

afterEach(() => vi.unstubAllGlobals());

const fire = (target: EventTarget, type: string, props: Record<string, unknown>) =>
  target.dispatchEvent(Object.assign(new Event(type), props));

function setup() {
  const target = new EventTarget();
  const sent: ClientErrorPayload[] = [];
  const reloads: number[] = [];
  installErrorReporter(target, (p) => sent.push(p), () => reloads.push(1));
  return { target, sent, reloads };
}

describe("installErrorReporter", () => {
  it("reports an uncaught error with its stack", () => {
    const { target, sent } = setup();
    fire(target, "error", { error: new Error("https://svelte.dev/e/each_key_duplicate") });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "Error", message: "https://svelte.dev/e/each_key_duplicate" });
    expect(sent[0].stack).toContain("error-reporter.test.ts");
    expect(typeof sent[0].build).toBe("string");
  });

  it("reports an unhandled rejection, including a non-Error reason", () => {
    const { target, sent } = setup();
    fire(target, "unhandledrejection", { reason: new TypeError("x is undefined") });
    fire(target, "unhandledrejection", { reason: "plain string" });
    expect(sent.map((p) => `${p.name}: ${p.message}`)).toEqual(["TypeError: x is undefined", "Error: plain string"]);
  });

  it("reports a crash repeating every render once, and caps distinct reports per page", () => {
    const { target, sent } = setup();
    for (let i = 0; i < 50; i++) fire(target, "error", { error: new Error("same") });
    for (let i = 0; i < 50; i++) fire(target, "error", { error: new Error(`distinct ${i}`) });
    expect(sent.map((p) => p.message)).toEqual(["same", "distinct 0", "distinct 1", "distinct 2", "distinct 3"]);
  });

  it("ignores an opaque cross-origin 'Script error.' that carries no Error", () => {
    const { target, sent } = setup();
    fire(target, "error", { message: "Script error.", error: null });
    expect(sent).toEqual([]);
  });

  it("reports a lazy chunk that fails to load even when the caller catches it, then reloads onto the current build", async () => {
    const { sent, reloads } = setup();
    const stale = new TypeError("Failed to fetch dynamically imported module: /assets/pdf-OLD.js");
    await expect(lazyImport(() => Promise.reject(stale))).rejects.toBe(stale);
    expect(sent.map((p) => `${p.name}: ${p.message}`)).toEqual([`TypeError: ${stale.message}`]);
    expect(reloads).toHaveLength(1);
  });

  it("does not reload for an ordinary uncaught error", () => {
    const { target, reloads } = setup();
    fire(target, "error", { error: new Error("boom") });
    expect(reloads).toEqual([]);
  });
});

describe("reportCaughtError", () => {
  it("files a handled failure, sharing the page's dedupe and cap with uncaught ones", () => {
    const { target, sent } = setup();
    const failure = new Error("Failed to fetch");
    failure.name = "VaultSaveFailed";

    reportCaughtError(failure);
    reportCaughtError(failure); // a retry of the same failing save must not file twice
    fire(target, "error", { error: failure });

    expect(sent.map((p) => `${p.name}: ${p.message}`)).toEqual(["VaultSaveFailed: Failed to fetch"]);
  });
});

// A 503 from the platform never reaches the server's error sink, and a 5xx a route classified itself
// is deliberately not filed there either — so the browser is the only witness.
describe("installApiFailureReporting", () => {
  const scopeAnswering = (status: number) => {
    const scope = { fetch: (async () => new Response("", { status })) as unknown as typeof fetch };
    installApiFailureReporting(scope, "https://lexitar.example");
    return scope;
  };

  const scopeAnsweringBody = (status: number, body: unknown) => {
    const scope = {
      fetch: (async () =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    };
    installApiFailureReporting(scope, "https://lexitar.example");
    return scope;
  };

  it("reports a 5xx on an API route, naming the route and status", async () => {
    const { sent } = setup();
    const scope = scopeAnswering(503);

    await scope.fetch("https://lexitar.example/api/refresh-range", { method: "POST" });

    expect(sent.map((p) => `${p.name}: ${p.message}`)).toEqual(["ApiUnavailable: POST /api/refresh-range → 503"]);
  });

  it("masks the id segment, which can be a vault slug", async () => {
    const { sent } = setup();
    const scope = scopeAnswering(500);

    await scope.fetch(new Request("https://lexitar.example/api/vault/834bc60d-c937-467d-9e78-3caa734acf45", { method: "PUT" }));

    expect(sent[0].message).toBe("PUT /api/vault/… → 500");
  });

  it("leaves 4xx, other origins and the sink itself alone", async () => {
    const { sent } = setup();
    await scopeAnswering(422).fetch("https://lexitar.example/api/extract", { method: "POST" });
    await scopeAnswering(500).fetch("https://elsewhere.example/api/extract", { method: "POST" });
    await scopeAnswering(500).fetch("https://lexitar.example/api/client-error", { method: "POST" });

    expect(sent).toEqual([]);
  });

  it("hands the response back untouched", async () => {
    setup();
    const res = await scopeAnswering(503).fetch("https://lexitar.example/api/leaf-regen", { method: "POST" });

    expect(res.status).toBe(503);
  });

  // A vendor answering 429/503/529 becomes `ai_busy`, which the app retries and explains. Filing it
  // as a bug buries the real ones and pins the promotion gate on a build no fix can clear.
  it("leaves a failure the handler classified itself alone", async () => {
    const { sent } = setup();
    const scope = scopeAnsweringBody(503, { errorCode: "ai_busy", error: "The AI is busy." });

    await scope.fetch("https://lexitar.example/api/corpus-warm", { method: "POST" });

    expect(sent).toEqual([]);
  });

  it("still reports a 5xx the server never classified", async () => {
    const { sent } = setup();
    const scope = scopeAnsweringBody(500, { error: "internal error" });

    await scope.fetch("https://lexitar.example/api/corpus-warm", { method: "POST" });

    expect(sent.map((p) => p.message)).toEqual(["POST /api/corpus-warm → 500"]);
  });

  // The platform's own 5xx is HTML or nothing at all, and it is the one the server's sink misses.
  it("still reports a 5xx whose body is not JSON", async () => {
    const { sent } = setup();
    const scope = {
      fetch: (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch,
    };
    installApiFailureReporting(scope, "https://lexitar.example");

    await scope.fetch("https://lexitar.example/api/chat", { method: "POST" });

    expect(sent.map((p) => p.message)).toEqual(["POST /api/chat → 502"]);
  });

  it("leaves the body readable by the caller it was answered to", async () => {
    setup();
    const scope = scopeAnsweringBody(503, { errorCode: "ai_busy" });

    const res = await scope.fetch("https://lexitar.example/api/leaf-regen", { method: "POST" });

    expect(await res.json()).toEqual({ errorCode: "ai_busy" });
  });
});

// W85 — the sink shares a deployment with the code it reports on, so the outage that produces a
// report is routinely the outage that loses it. These pin the retry buffer.
describe("a report the sink could not take is not lost", () => {
  const memoryStorage = () => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  };

  /** Installs with the REAL sink (the default), which is the only path the buffer sits on. */
  function live(answers: number[]) {
    const posted: ClientErrorPayload[] = [];
    let i = 0;
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)) as ClientErrorPayload);
      return new Response(null, { status: answers[Math.min(i++, answers.length - 1)] });
    }));
    return posted;
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("buffers a 503'd report and delivers it on the next page load", async () => {
    const posted = live([503, 204]);
    const target = new EventTarget();
    installErrorReporter(target);
    fire(target, "error", { error: new Error("boom") });
    await settle();
    expect(posted).toHaveLength(1);

    // The next page load — a fresh install, which is where the drain happens.
    installErrorReporter(new EventTarget());
    await settle();
    expect(posted.map((p) => p.message)).toEqual(["boom", "boom"]);
  });

  it("keeps the build the report was captured on, not the one that delivered it", async () => {
    const posted = live([503, 204]);
    const target = new EventTarget();
    installErrorReporter(target);
    fire(target, "error", { error: new Error("boom") });
    await settle();

    installErrorReporter(new EventTarget());
    await settle();
    expect(posted[1].build).toBe(posted[0].build);
  });

  it("does not retry a verdict on the payload itself", async () => {
    const posted = live([413, 204]);
    const target = new EventTarget();
    installErrorReporter(target);
    fire(target, "error", { error: new Error("huge") });
    await settle();

    installErrorReporter(new EventTarget());
    await settle();
    expect(posted).toHaveLength(1);
  });

  it("gives up rather than redelivering the same report on every load forever", async () => {
    const posted = live([503]);
    const target = new EventTarget();
    installErrorReporter(target);
    fire(target, "error", { error: new Error("always down") });
    await settle();

    for (let i = 0; i < 5; i++) {
      installErrorReporter(new EventTarget());
      await settle();
    }
    expect(posted.length).toBeLessThanOrEqual(2);
  });

});
