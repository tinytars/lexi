import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ServerDeathReporter from "../e2e/_server-death-reporter";
import type { TestCase, TestResult, FullResult } from "@playwright/test/reporter";

// W69 — the reporter's whole job is a JUDGEMENT: connection errors plus a dead port means the server
// died; connection errors plus a LIVE port means those were real test failures. Getting that backwards
// in either direction is worse than not having the reporter — it would either excuse a genuine
// regression or keep blaming the code for a jetsam kill.
//
// This is the sabotage test the milestone calls for, done deterministically: no browser, no wrangler,
// no port 8788. Feeding the reporter synthetic results and stubbing the probe exercises exactly the
// decision the real cascade would trigger, and it runs in milliseconds instead of 5.5 minutes.

const testCase = (title: string) => ({ titlePath: () => ["", "spec.ts", title] }) as unknown as TestCase;

const failedWith = (message: string) =>
  ({ status: "failed", error: { message }, errors: [{ message }] }) as unknown as TestResult;

const CONN = "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8788/";

let stderr: string;

beforeEach(() => {
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

/** The probe is the evidence. Stub it rather than depending on whether anything holds 8788 locally. */
function stubPort(alive: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => (alive ? Promise.resolve(new Response("ok")) : Promise.reject(new Error("ECONNREFUSED")))),
  );
}

async function run(reporter: ServerDeathReporter) {
  await reporter.onEnd({ status: "failed" } as FullResult);
}

describe("the e2e reporter names a server death instead of blaming the code", () => {
  it("connection errors + a dead port => the banner, naming it NOT a regression", async () => {
    stubPort(false);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("opens the cover"), failedWith(CONN));
    r.onTestEnd(testCase("opens the markers"), failedWith(CONN));
    await run(r);

    expect(stderr).toContain("THE SERVER AT http://localhost:8788/ IS DEAD");
    expect(stderr).toContain("NOT a code regression");
    expect(stderr).toContain("2 test(s) failed on a dead connection");
    // Names the first casualty, so the log points at where the cascade began.
    expect(stderr).toContain("spec.ts › opens the cover");
  });

  // The direction that matters most: a live port means the connection errors were transient and the
  // failures are real. Excusing those would make the gate lie in the dangerous direction.
  it("connection errors + a LIVE port => silence, because those were real failures", async () => {
    stubPort(true);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("opens the cover"), failedWith(CONN));
    await run(r);
    expect(stderr).toBe("");
  });

  it("ordinary assertion failures never probe the port at all", async () => {
    stubPort(false); // even with a dead port, a non-connection failure must not claim a server death
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("expects 3 rows"), failedWith("expect(received).toHaveCount(expected)\n  3 vs 2"));
    await run(r);
    expect(stderr).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a fully green run reports nothing", async () => {
    stubPort(false);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("opens the cover"), { status: "passed", errors: [] } as unknown as TestResult);
    await run(r);
    expect(stderr).toBe("");
  });

  // `retries: 1` makes this a real shape, not a hypothetical: a test can hit a connection blip and
  // still PASS on its retry attempt, carrying the error along. A recovered blip is not a dead server,
  // and counting it would let one transient hiccup mute a run that genuinely failed on assertions.
  it("a test that recovered on retry is not a casualty, even carrying a connection error", async () => {
    stubPort(false);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("opens the cover"), {
      status: "passed",
      error: { message: CONN },
      errors: [{ message: CONN }],
    } as unknown as TestResult);
    await run(r);
    expect(stderr).toBe("");
  });

  it("counts a timed-out test whose error is a connection error", async () => {
    stubPort(false);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("waits forever"), {
      status: "timedOut",
      error: { message: CONN },
      errors: [{ message: CONN }],
    } as unknown as TestResult);
    await run(r);
    expect(stderr).toContain("1 test(s) failed on a dead connection");
  });
});

// W74 — the same judgement, now also written to disk.
//
// The banner above told a HUMAN "re-run before investigating the code". CI is the reader now: the gate
// retries a shard once, and only when this file exists (see .github/workflows/gate.yml). That makes the
// live-port direction load-bearing in a second way — a sentinel written on an ordinary failure would
// mean a blanket retry, and a blanket retry buries the regression it retries past. Nothing in the
// workflow would look any different while it happened.
describe("the sentinel the gate's shard retry reads", () => {
  const SENTINEL = join(tmpdir(), `e2e-death-${process.pid}`, "server-death");

  beforeEach(() => {
    process.env.E2E_DEATH_SENTINEL = SENTINEL;
    rmSync(join(tmpdir(), `e2e-death-${process.pid}`), { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.E2E_DEATH_SENTINEL;
    rmSync(join(tmpdir(), `e2e-death-${process.pid}`), { recursive: true, force: true });
  });

  it("is written on a dead port, naming the first casualty for the log", async () => {
    stubPort(false);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("opens the cover"), failedWith(CONN));
    await run(r);
    expect(existsSync(SENTINEL)).toBe(true);
    expect(readFileSync(SENTINEL, "utf8")).toContain("opens the cover");
  });

  it("is NOT written on a live port — that run must not be retried", async () => {
    stubPort(true);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("opens the cover"), failedWith(CONN));
    await run(r);
    expect(existsSync(SENTINEL), "a live port must never trigger the gate's retry").toBe(false);
  });

  it("is NOT written for an ordinary assertion failure", async () => {
    stubPort(false);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("expects 3 rows"), failedWith("expect(received).toHaveCount(expected)"));
    await run(r);
    expect(existsSync(SENTINEL)).toBe(false);
  });

  // Absent the env var the reporter must still print its banner — the sentinel is for CI, and a local
  // run has no workflow to tell.
  it("is optional: without E2E_DEATH_SENTINEL the banner still prints", async () => {
    delete process.env.E2E_DEATH_SENTINEL;
    stubPort(false);
    const r = new ServerDeathReporter();
    r.onTestEnd(testCase("opens the cover"), failedWith(CONN));
    await run(r);
    expect(stderr).toContain("IS DEAD");
  });
});
