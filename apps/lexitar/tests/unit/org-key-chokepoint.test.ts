// VAULT.md §2 permits an operator read on condition that every use is logged. This file is that
// condition's enforcement: static sweeps derived from the tree (so a new file cannot dodge them by
// being new — the shape tests/unit/recovery-invariants.test.ts I1 already uses), plus the behaviour
// scripts/org-unwrap.ts adds on top of them — the row is recorded BEFORE the key exists, and an id
// that could not be audited never reaches the crypto.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { insertSqlFrom, mockD1Lookup } from "../support/wrangler-mock";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = resolve(APP, "scripts");

function scriptFiles(dir = SCRIPTS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return scriptFiles(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

const files = scriptFiles();
// A plain text sweep, so a mention in a comment counts too. That is deliberate: it keeps the tree's
// prose honest about where the key is opened, at the price of rewording a sentence now and then.
const mentioning = (needle: string) =>
  files
    .filter((f) => readFileSync(f, "utf8").includes(needle))
    .map((f) => f.slice(APP.length + 1))
    .sort();

describe("the org key has one chokepoint in the tree", () => {
  it("finds the scripts tree at all, so an empty sweep cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("is opened in one place and reached from one module", () => {
    expect(mentioning("loadOrgPrivateKey")).toEqual(["scripts/org-key.ts", "scripts/org-unwrap.ts"]);
  });

  it("is turned into a DEK only by the chokepoint, and by two scripts that use someone else's key", () => {
    // api-session.ts unwraps the OWNER's DEK with the owner's own account key, from a passphrase given
    // at run time; rotate-pilot-credentials.ts unwraps with the PATIENT's key and touches only
    // `loadOrgPublicKey`. Neither reaches anything the org key grants, so neither owes an org-key row.
    //
    // There were three until 2026-10-07. The third was scripts/mint-org-envelope.ts, which unwrapped
    // with a PUBLISHED account key handed to it in a file — strictly less capability than the org
    // key, not more, and audited under its own action rather than `org_key_decrypt`. It existed to
    // close one historical gap on one named dev vault, it closed it on 2026-10-06, and Phase 4(m) of
    // the remediation deleted it the day prod was re-keyed: a command that opens a vault from a
    // terminal with a key an unknown number of people hold is a standing liability once the gap it
    // was written for is shut. `git log` keeps it if the shape is ever wanted again.
    expect(mentioning("unwrapDEKWithPrivateKey")).toEqual([
      "scripts/api-session.ts",
      "scripts/org-unwrap.ts",
      "scripts/rotate-pilot-credentials.ts",
    ]);
  });

  // Measured on dev 2026-10-06 and the reason this test exists: `npm run vault:rekey -- --apply`
  // rotated five vaults, printed five `access-log: no vault row for "<stem>"` lines and wrote ZERO
  // rows to `phi_access_events`. access-log.ts resolves a use by `vaults.r2_key`, the repoint moves
  // it, and the miss path skips rather than throwing — deliberately, for local-only fixtures, which
  // access-log.test.ts pins. So a script that repoints and then flushes loses its whole audit trail
  // silently, which is the one failure mode access-log.ts's own header says it exists to close.
  it("flushes the audit buffer BEFORE it repoints r2_key, in every script that repoints one", () => {
    // Comments are blanked, not deleted, so the surviving offsets still compare. Without this the
    // check passes against a commented-out flush — which is how the first version of this test was
    // caught: the control run with the real call commented out stayed green.
    const code = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    const repointers = files.filter((f) => /SET r2_key/.test(code(readFileSync(f, "utf8"))));
    expect(repointers.length).toBeGreaterThan(0);
    for (const file of repointers) {
      const src = code(readFileSync(file, "utf8"));
      const flush = src.indexOf("await flushOrgKeyUses()");
      const repoint = src.search(/SET r2_key/);
      expect(flush, `${relative(APP, file)} repoints r2_key and never flushes`).toBeGreaterThan(-1);
      expect(flush, `${relative(APP, file)} flushes after the repoint — the lookup misses and the
        use is skipped`).toBeLessThan(repoint);
    }
  });
});

const loadOrgPrivateKey = vi.fn<() => Promise<CryptoKey>>();
vi.mock("../../scripts/org-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/org-key")>()),
  loadOrgPrivateKey: () => loadOrgPrivateKey(),
}));

const execFileSyncMock = vi.fn<(...args: unknown[]) => string>();
vi.mock("node:child_process", () => ({ execFileSync: (...args: unknown[]) => execFileSyncMock(...args) }));

const { unwrapVaultDEK, envelopeFromHex } = await import("../../scripts/org-unwrap");
const { flushOrgKeyUses } = await import("../../scripts/access-log");

const ENVELOPE = envelopeFromHex("00ff", '{"kty":"EC","crv":"P-256","x":"x","y":"y"}');
let stateHome: string;

beforeEach(() => {
  // The spool is a real file; keep this suite off the operator's own backlog and off other suites'.
  stateHome = mkdtempSync(join(tmpdir(), "lexitar-chokepoint-"));
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  loadOrgPrivateKey.mockReset();
  execFileSyncMock.mockReset();
});

afterEach(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

describe("unwrapVaultDEK", () => {
  // The ordering IS the guarantee: if the row were written after the unwrap, a decrypt that threw
  // half-way — or a process killed between the two — would be a use with no record of it.
  it("records the use before it can hand back a key, so a failed unwrap is still logged", async () => {
    loadOrgPrivateKey.mockRejectedValue(new Error("ORG_KEY_PASSPHRASE is not set"));
    mockD1Lookup(execFileSyncMock, [{ vault_id: "vault-alex", owner_account_id: "owner-alex", r2_key: "data-alex.enc" }]);

    await expect(unwrapVaultDEK(ENVELOPE, { vaultId: "alex", purpose: "chokepoint-probe" })).rejects.toThrow(
      /ORG_KEY_PASSPHRASE/,
    );
    await flushOrgKeyUses();

    expect(insertSqlFrom(execFileSyncMock)).toContain('"purpose":"chokepoint-probe"');
  });

  it("refuses an id the audit could not resolve, before the key is opened at all", async () => {
    await expect(unwrapVaultDEK(ENVELOPE, { vaultId: "Not A Slug", purpose: "probe" })).rejects.toThrow(
      /cannot be audited/,
    );

    expect(loadOrgPrivateKey).not.toHaveBeenCalled();
    await flushOrgKeyUses();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
