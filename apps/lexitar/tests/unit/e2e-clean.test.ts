// W74 — the cleanup script must never kill a process it does not own.
//
// It used to `pkill` a bare command pattern and pipe an unfiltered `lsof -ti tcp:8788` into `kill -9`.
// That is what made two agents lethal to each other, and it killed CI too: whichever run started
// second murdered the first so it could have the port. "Self-heal" and "kill the neighbour" were the
// same line of code, and the collision reports that opened this milestone are what it looks like from
// the other end.
//
// Tested for real, against a live listener on a scratch port, because the property is behavioural: a
// static grep for the ownership check passes just as happily when the check is present and its result
// is ignored (verified — an `if true` mutation survives the static form).

import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLEAN = resolve(ROOT, "scripts", "e2e-clean.sh");
const SERVE = resolve(ROOT, "scripts", "e2e-serve.sh");
const PORT = "8797"; // not 8788: this must never disturb a real e2e run on the same machine

// lsof is how a pid is attributed to a checkout — the script cannot do its job without it, so there is
// nothing meaningful to assert when it is absent.
const hasLsof = spawnSync("which", ["lsof"]).status === 0;

let child: ChildProcess | null = null;
afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
});

/** A listener on PORT whose working directory is `cwd`. Resolves once it is actually bound. */
function listenFrom(cwd: string): Promise<ChildProcess> {
  const p = spawn(
    process.execPath,
    ["-e", `require("http").createServer(()=>{}).listen(${PORT},()=>console.log("up"))`],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  return new Promise((ok, fail) => {
    p.stdout!.on("data", (d) => String(d).includes("up") && ok(p));
    p.on("exit", (c) => fail(new Error(`listener exited early (${c})`)));
    setTimeout(() => fail(new Error("listener never bound")), 5_000);
  });
}

function run(script: string) {
  return spawnSync("bash", [script], {
    cwd: ROOT,
    env: { ...process.env, E2E_PORT: PORT },
    encoding: "utf8",
    timeout: 60_000,
  });
}
const clean = () => run(CLEAN);

const alive = (p: ChildProcess) => {
  try {
    process.kill(p.pid!, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!hasLsof)("e2e-clean only reaps its own checkout", () => {
  it("leaves a listener owned by another directory running, and says so", async () => {
    child = await listenFrom(tmpdir());
    const r = clean();
    expect(alive(child), "a foreign process was killed — this is the agent-vs-agent bug").toBe(true);
    // The message is the point: a skipped kill that says nothing is indistinguishable from a no-op,
    // and the caller is about to fail on a busy port with no idea who has it.
    expect(r.stderr).toContain("NOT killing it");
    expect(r.stderr).toContain(tmpdir().replace(/\/$/, ""));
  });

  it("still reaps a listener from this checkout", async () => {
    child = await listenFrom(ROOT);
    clean();
    await expect.poll(() => alive(child!), { timeout: 5_000 }).toBe(false);
  });

  it("exits 0 either way, since a busy foreign port is not this script's failure", async () => {
    child = await listenFrom(tmpdir());
    expect(clean().status).toBe(0);
  });

  // e2e-serve.sh is the one that actually destroys something: `rm -rf .wrangler/state`. e2e-clean
  // declining to kill the foreign server is only half the fix — without this, the run proceeds to
  // wipe the local D1 the foreign run is mid-suite against, and only THEN fails to bind the port.
  it("e2e-serve refuses to start behind a foreign server, before touching state", async () => {
    child = await listenFrom(tmpdir());
    const r = run(SERVE);
    expect(r.status, "e2e-serve should refuse, not proceed to rm -rf").toBe(1);
    expect(r.stderr).toContain("refusing to start");
    // The guard sits above the build for a reason: a refusal that costs 30s of vite first is one a
    // person learns to run past. If this ever starts building, the guard has drifted back down.
    expect(r.stdout, "the guard ran after the build").not.toContain("vite");
  });
});
