import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_TESTS } from "../../vitest.config";

// W69 — the unit suite must be importable on a machine with no credentials.
//
// `scripts/vault-verify.ts` used to resolve ROSTER_PASS/PASSPHRASE at MODULE scope and throw there.
// `tests/unit/vault-integrity.test.ts` imports it, so on any machine without
// ~/.claude/infra/cloud/credentials the whole file failed at COLLECTION — not as a skip, as an error.
// That single line is what pinned the entire unit suite to this Mac and blocked a GitHub-hosted job.
//
// The fix is not "set the variable in CI" (that would mean copying the family passphrase into Actions
// secrets, which the repo forbids) — it is that needing a credential to RUN must not mean needing one
// to IMPORT. This test holds that line: it strips the variables, re-imports fresh, and requires the
// module to load anyway while still refusing to do the work.

const CREDS = ["ROSTER_PASS", "PASSPHRASE", "ORG_KEY_PASSPHRASE"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Simulate a GitHub-hosted runner: no credentials directory, and none of the variables it would set.
 *
 * Both halves are required, and the second is the subtle one. vault-verify.ts:6 imports ./load-creds,
 * so `vi.resetModules()` RE-RUNS it — and load-creds fills any variable that is currently undefined
 * from ~/.claude/infra/cloud/credentials. Deleting the variables alone therefore does nothing on this
 * Mac: they come straight back. Pointing PLOVER_CREDENTIALS_DIR at nothing is what actually reproduces
 * ubuntu-latest, where that directory has never existed.
 */
function withoutCredentials() {
  vi.stubEnv("PLOVER_CREDENTIALS_DIR", "/nonexistent/credentials/dir");
  for (const key of CREDS) vi.stubEnv(key, undefined);
  vi.resetModules(); // force a fresh module-scope evaluation, which is where the old throw lived
}

describe("modules the unit suite imports do not require credentials to LOAD", () => {
  it("scripts/vault-verify imports with no credentials set", async () => {
    withoutCredentials();
    const mod = await import("../../scripts/vault-verify");
    expect(typeof mod.verifyVaults).toBe("function");
    expect(typeof mod.rosterPass).toBe("function");
  });

  it("but verifyVaults still refuses to run, loudly and by name", async () => {
    withoutCredentials();
    const { verifyVaults } = await import("../../scripts/vault-verify");
    await expect(verifyVaults()).rejects.toThrow(/ROSTER_PASS\/PASSPHRASE not set/);
  });

  it("rosterPass returns the value when one IS set", async () => {
    // Exported-but-empty: must defer to PASSPHRASE rather than count as "set".
    vi.stubEnv("ROSTER_PASS", "");
    vi.stubEnv("PASSPHRASE", "from-passphrase");
    vi.resetModules();
    const { rosterPass } = await import("../../scripts/vault-verify");
    expect(rosterPass()).toBe("from-passphrase");
  });

  // load-creds is the other half of the promise: on a hosted runner the credentials directory simply
  // does not exist, and that must be a no-op rather than a failure.
  it("scripts/load-creds is a no-op when the credentials directory is absent", async () => {
    vi.stubEnv("PLOVER_CREDENTIALS_DIR", "/nonexistent/credentials/dir");
    vi.resetModules();
    await expect(import("../../scripts/load-creds")).resolves.toBeDefined();
  });
});

// ── the partition itself ────────────────────────────────────────────────────────────────────────
//
// `npm test` (hosted) and `npm run test:data` (self-hosted) split the suite by INPUT. The split is
// only safe while it stays true, and it can rot two ways — a data test drifting out of the list, or a
// new test quietly reaching for records/private and breaking the hosted job. Both are cheap to hold.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A READ of records/private, not a mention of it. Comments discuss the path, and several tests build
// synthetic `records/private/...` strings they never open — matching those would make this guard cry
// wolf, which is the exact failure mode this milestone exists to remove.
//
// Known limitation: a path assembled indirectly slips through. The backstop is that the hosted job
// fails loudly on a missing file, so this catches the common case early rather than every case.
const PHI_READ =
  /(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|createReadStream)\s*\(\s*(?:resolve\s*\(\s*)?["'`]records\/private/;

describe("the hosted/local test partition", () => {
  it("every file named in DATA_TESTS actually exists", () => {
    for (const rel of DATA_TESTS) expect(existsSync(resolve(ROOT, rel)), rel).toBe(true);
  });

  // The load-bearing one. A test outside DATA_TESTS that reads records/private runs on ubuntu-latest,
  // where that directory does not exist — so it fails the hosted job for a reason that has nothing to
  // do with the change being gated. Catch it here, at the commit that adds it.
  it("no test outside DATA_TESTS reaches into records/private", () => {
    const dataSet = new Set(DATA_TESTS.map((p) => resolve(ROOT, p)));
    const offenders = readdirSync(resolve(ROOT, "tests/unit"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => resolve(ROOT, "tests/unit", f))
      .filter((f) => !dataSet.has(f) && PHI_READ.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("finds the unit tests at all, so an empty sweep cannot pass silently", () => {
    expect(readdirSync(resolve(ROOT, "tests/unit")).filter((f) => f.endsWith(".test.ts")).length).toBeGreaterThan(150);
  });
});
