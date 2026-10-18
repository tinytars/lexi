// WHAT THIS PINS, AND WHY IT IS NOT OBVIOUS. `npm run doctor` has two audiences with opposite
// expectations, and the whole value of the script is that it serves both from one run. An OPERATOR
// wants a missing secret to be a failure. A CLONER has no credential store at all and must not be
// told the tree is broken — six documents point them at this command, and a preflight that exits 1
// on the ordinary state of a fresh clone teaches them the documentation cannot be trusted, which is
// worse than having shipped no preflight.
//
// So the contract asserted here is the cloner's half: with both credential-store variables pointed
// at empty directories, every question that needs a credential is SKIPPED WITH A STATED REASON, a
// missing store is a `warn` that names what it blocks, and the exit code is 0. That is a property
// of the script's structure (`set -uo pipefail` with no `-e`, and a `creds_ok` gate on the remote
// half) and structure is exactly what a later edit breaks silently.
//
// This suite deliberately does NOT assert the operator half. Doing so would need a live Cloudflare
// token, which would make the unit suite — the thing CREDENTIALS.md measures as passing with no
// credentials at all — depend on one.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function doctor(): { out: string; status: number } {
  const empty = () => mkdtempSync(join(tmpdir(), "doctor-nostore-"));
  try {
    const out = execFileSync("bash", ["scripts/check-env.sh"], {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      env: { ...process.env, LEXI_CREDENTIALS_DIR: empty(), PLOVER_CREDENTIALS_DIR: empty() },
    });
    return { out, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? "") + (err.stderr ?? ""), status: err.status ?? -1 };
  }
}

describe("npm run doctor, on a clone with no credential store", () => {
  const { out, status } = doctor();

  // The headline. Everything below explains a failure of this one.
  it("exits 0, because having no credential store is the ordinary state of a clone", () => {
    expect(out).not.toMatch(/^ {2}FAIL/m);
    expect(status).toBe(0);
  });

  // A missing store is reported, not hidden — and the report names the consequence rather than the
  // path, because "no store holds cloudflare.env" tells a reader nothing about what they just lost.
  it("warns that no store holds the Cloudflare token and says what that blocks", () => {
    expect(out).toMatch(/^ {2}warn .*cloudflare\.env/m);
    expect(out).toMatch(/Blocks: .*wrangler/);
  });

  // The questions that cannot be answered without a credential are skipped with a reason. A silent
  // omission reads as a pass, which is the failure mode this line exists to prevent.
  it("skips the deployed-environment and backup checks with a stated reason", () => {
    const skips = out.split("\n").filter((l) => l.startsWith("  skip "));
    expect(skips.length).toBeGreaterThanOrEqual(2);
    for (const l of skips) expect(l.length).toBeGreaterThan(40);
  });

  // The derived set is the load-bearing half of the script: it is why adding `env.NEW_SECRET` to a
  // route makes that secret required from the same commit, with nobody editing the preflight. A
  // broken derivation (a `grep` that silently matches nothing) would leave the count at or near 0
  // and every other check would still read green, so the count is asserted and not the names.
  it("derives the required secret set from the code rather than from a list", () => {
    const m = out.match(/derived (\d+) required secrets/);
    expect(m, out).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(10);
  });

  // Six documents cite `npm run doctor` and `npm run doctor:prod` by those names. The scripts
  // existing is what they promise; a rename that updates one and not the other restores the exact
  // defect this script was written to end.
  it("is reachable by both the names the documentation cites", () => {
    const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.doctor).toContain("scripts/check-env.sh");
    expect(pkg.scripts["doctor:prod"]).toContain("scripts/check-env.sh");
    expect(pkg.scripts["doctor:prod"]).toContain("--prod");
  });
});
