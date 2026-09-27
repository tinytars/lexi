import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/access-log.ts talks to prod/dev D1 only through node:child_process execFileSync →
// wrangler.sh — there is no exported runD1 or injectable runner (it's a private function baked
// into flushOrgKeyUses). The only seam available without editing scripts/ is mocking
// node:child_process itself, at the same external-command boundary the repo already mocks
// @simplewebauthn/server at in passkey-function.test.ts. This captures every SQL string the
// module would have sent to wrangler, so the assertions below never spawn a real process.
const execFileSyncMock = vi.fn<(...args: unknown[]) => string>();
vi.mock("node:child_process", () => ({ execFileSync: (...args: unknown[]) => execFileSyncMock(...args) }));

const { recordOrgKeyUse, flushOrgKeyUses, spoolUnflushedSync } = await import("../../scripts/access-log");

const ORG_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

function sqlArg(call: unknown[]): string {
  const args = call[1] as string[];
  return args[args.length - 1];
}

function mockLookup(rows: Record<string, string>[]) {
  execFileSyncMock.mockImplementation((...call: unknown[]) => {
    const sql = sqlArg(call);
    if (sql.startsWith("SELECT")) return JSON.stringify([{ results: rows }]);
    return JSON.stringify([{ results: [] }]);
  });
}

// The spool is a real file, so each test gets its own XDG_STATE_HOME rather than sharing the one
// vitest.config.ts points at — which is the safety net that keeps any suite off the operator's own
// backlog, not an isolation mechanism between tests.
let stateHome: string;
const spoolFile = () => join(stateHome, "lexitar", "access-spool.ndjson");
const spooled = () =>
  existsSync(spoolFile())
    ? readFileSync(spoolFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>)
    : [];

beforeEach(async () => {
  stateHome = mkdtempSync(join(tmpdir(), "lexitar-access-log-"));
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  vi.stubEnv("ORG_ACCESS_LOG", "");
  // Drain whatever the previous test left buffered (module state is a singleton for the file)
  // before each test starts, so tests don't see each other's uses.
  mockLookup([]);
  await flushOrgKeyUses().catch(() => {});
  execFileSyncMock.mockClear();
});

afterEach(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

describe("recordOrgKeyUse / flushOrgKeyUses", () => {
  it("dedupes identical (clientId, purpose) pairs, keeping distinct purposes for the same client", async () => {
    mockLookup([{ vault_id: "vault-blair", owner_account_id: "owner-blair", r2_key: "data-blair.enc" }]);

    recordOrgKeyUse({ clientId: "blair", purpose: "restore-drill" });
    recordOrgKeyUse({ clientId: "blair", purpose: "restore-drill" }); // duplicate — collapses
    recordOrgKeyUse({ clientId: "blair", purpose: "ingest" });

    await flushOrgKeyUses();

    const insertCall = execFileSyncMock.mock.calls.find((c) => sqlArg(c).startsWith("INSERT"));
    expect(insertCall).toBeTruthy();
    const insertSql = sqlArg(insertCall!);
    expect(insertSql.match(/'org_key_decrypt'/g)).toHaveLength(2);
    expect(insertSql).toContain('"purpose":"restore-drill"');
    expect(insertSql).toContain('"purpose":"ingest"');
  });

  // `off` is for working offline, not for working unaudited: it moves the use to a file on disk and
  // the next online flush sends it. It used to clear the buffer and return, losing the use outright.
  it("ORG_ACCESS_LOG=off spools the use instead of reaching wrangler, and the next flush drains it", async () => {
    vi.stubEnv("ORG_ACCESS_LOG", "off");
    recordOrgKeyUse({ clientId: "alex", purpose: "manual-decrypt" });
    await flushOrgKeyUses();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(spooled()).toEqual([expect.objectContaining({ clientId: "alex", purpose: "manual-decrypt" })]);

    vi.stubEnv("ORG_ACCESS_LOG", "");
    mockLookup([{ vault_id: "vault-alex", owner_account_id: "owner-alex", r2_key: "data-alex.enc" }]);
    await flushOrgKeyUses();

    const insertSql = sqlArg(execFileSyncMock.mock.calls.find((c) => sqlArg(c).startsWith("INSERT"))!);
    expect(insertSql).toContain('"purpose":"manual-decrypt"');
    // Drained, not copied: a spooled use that flushed must not be sent again on the next run.
    expect(existsSync(spoolFile())).toBe(false);
  });

  // The whole point of the spool: a script that decrypts and then dies still leaves the row behind.
  it("spools from the exit handler when a script never flushes at all", () => {
    recordOrgKeyUse({ clientId: "blair", purpose: "crashed-midway" });
    expect(process.listeners("exit")).toContain(spoolUnflushedSync);

    spoolUnflushedSync();

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(spooled()).toEqual([expect.objectContaining({ clientId: "blair", purpose: "crashed-midway" })]);
  });

  // A flush that cannot reach D1 used to lose everything it had taken out of the buffer.
  it("returns a failed flush's uses to the spool and still throws", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("wrangler: network unreachable");
    });
    recordOrgKeyUse({ clientId: "alex", purpose: "offline-attempt" });

    await expect(flushOrgKeyUses()).rejects.toThrow(/network unreachable/);
    expect(spooled()).toEqual([expect.objectContaining({ clientId: "alex", purpose: "offline-attempt" })]);
  });

  it("rejects a non-slug clientId before ever calling wrangler", async () => {
    recordOrgKeyUse({ clientId: "Not_A_Slug!", purpose: "export" });

    await expect(flushOrgKeyUses()).rejects.toThrow(/refusing to log non-slug clientId/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("generates the expected INSERT SQL for a single buffered use", async () => {
    mockLookup([{ vault_id: "vault-x", owner_account_id: "owner-x", r2_key: "data-alex.enc" }]);

    recordOrgKeyUse({ clientId: "alex", purpose: "vault-verify" });
    await flushOrgKeyUses();

    const insertCall = execFileSyncMock.mock.calls.find((c) => sqlArg(c).startsWith("INSERT"));
    const insertSql = sqlArg(insertCall!);
    expect(insertSql).toMatch(
      new RegExp(
        `^INSERT INTO phi_access_events \\(id, actor_account_id, subject_account_id, vault_id, action, consent_ref, meta, created_at\\) VALUES \\('[0-9a-f-]{36}', '${ORG_ACCOUNT_ID}', 'owner-x', 'vault-x', 'org_key_decrypt', NULL, '\\{.*\\}', '.*'\\);$`
      )
    );
    expect(insertSql).toContain('"purpose":"vault-verify"');
  });

  it("skips a buffered use with no matching vault row instead of failing the flush", async () => {
    mockLookup([]); // no row for "ghost"
    recordOrgKeyUse({ clientId: "ghost", purpose: "export" });

    await flushOrgKeyUses();

    // Lookup happens, but no INSERT is issued since there was nothing to insert.
    expect(execFileSyncMock.mock.calls.some((c) => sqlArg(c).startsWith("INSERT"))).toBe(false);
  });
});
