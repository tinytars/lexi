import type { Reporter, TestCase, TestResult, FullResult } from "@playwright/test/reporter";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

// W69 — say "the server died" when the server died.
//
// The e2e step is 87% of the gate's wall time and 63% of its failures, and 15 of 27 e2e-failing CI
// runs were not about the code at all: `worker process exited unexpectedly (code=null, signal=SIGKILL)`
// — macOS jetsam killing workerd under memory pressure — followed by a cascade of
// `ERR_CONNECTION_REFUSED` as every remaining test hit a dead port. ~149 red assertions, none of them
// meaningful, presenting as a catastrophic regression. A gate that reports that way teaches you to
// re-run rather than read it.
//
// `maxFailures` (playwright.config.ts) caps the cascade at 5. This reporter is what names it: after
// the run, if anything failed with a connection error, probe the port ONCE. A dead port means the
// diagnosis is infrastructure; a live port means the connection errors were transient and the
// failures are real. The distinction is the whole point — this must never claim "server died" for a
// genuine regression, so the probe is the evidence, not the error text alone.
//
// Still reports failed. The gate should stay red; it should just be red about the right thing.
//
// W74 — it also drops a SENTINEL FILE, because "re-run before investigating the code" was advice only a
// human could act on, and CI is the reader now. A sharded run makes this routine rather than rare: on
// 2026-08-26 shard 12 lost workerd 16 seconds in, took 5 specs down with it, and was green on a plain
// re-run. Twelve shards is twelve chances per push for that to happen. The workflow reads the sentinel
// and retries THAT shard once — a fresh `test:e2e` starts a fresh server, which is the actual remedy.
// Retrying only on the sentinel is what keeps this from being a blanket retry that hides real failures:
// the file is written only when the port failed a live probe.

const execFileAsync = promisify(execFile);

const CONNECTION_ERROR = /net::ERR_CONNECTION_REFUSED|ECONNREFUSED|net::ERR_CONNECTION_RESET/;
const PROBE_URL = "http://localhost:8788/";
const PROBE_TIMEOUT_MS = 2_000;

/** The macOS memory-pressure killer leaves a trail; attach it so the diagnosis is checkable. */
async function jetsamEvidence(): Promise<string> {
  if (process.platform !== "darwin") return "";
  try {
    const { stdout } = await execFileAsync(
      "log",
      ["show", "--last", "5m", "--style", "compact", "--predicate", 'eventMessage CONTAINS "workerd"'],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = stdout.split("\n").filter((l) => /jetsam|memorystatus|kill/i.test(l));
    if (lines.length === 0) return "";
    return `\n  macOS log (last 5m, workerd + memory):\n${lines.slice(-8).map((l) => `    ${l.trim()}`).join("\n")}\n`;
  } catch {
    return ""; // `log show` can be denied or absent; evidence is a bonus, not a requirement
  }
}

async function portIsDead(): Promise<boolean> {
  try {
    await fetch(PROBE_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return false;
  } catch {
    return true;
  }
}

export default class ServerDeathReporter implements Reporter {
  private connectionFailures: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== "failed" && result.status !== "timedOut") return;
    const text = [result.error?.message, ...result.errors.map((e) => e.message)].filter(Boolean).join("\n");
    if (CONNECTION_ERROR.test(text)) this.connectionFailures.push(test.titlePath().slice(1).join(" › "));
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.connectionFailures.length === 0) return;
    if (!(await portIsDead())) return; // server is up — those really were test failures

    // Written before the message, so a crash while gathering macOS evidence cannot lose the signal.
    const sentinel = process.env.E2E_DEATH_SENTINEL;
    if (sentinel) {
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, `${this.connectionFailures.length} test(s) on a dead port; first: ${this.connectionFailures[0]}\n`);
    }

    const evidence = await jetsamEvidence();
    const [first] = this.connectionFailures;
    process.stderr.write(
      `\n${"=".repeat(78)}\n` +
        `E2E ABORTED — THE SERVER AT ${PROBE_URL} IS DEAD.\n` +
        `${"=".repeat(78)}\n` +
        `This is a SERVER DEATH (workerd killed, almost certainly by memory pressure),\n` +
        `NOT a code regression. Every assertion after the first connection error is\n` +
        `meaningless — do not read them as failures.\n\n` +
        `  ${this.connectionFailures.length} test(s) failed on a dead connection, first: ${first}\n` +
        `  the port did not answer a ${PROBE_TIMEOUT_MS}ms probe after the run\n` +
        evidence +
        `\n  What to check: free memory on the runner; whether a second e2e run (local or CI)\n` +
        `  was using port 8788 at the same time. Re-run before investigating the code.\n` +
        `${"=".repeat(78)}\n\n`,
    );
    // Deliberately leave result.status alone: a dead server is still a failed gate.
    void result;
  }
}
