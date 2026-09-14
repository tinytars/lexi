import { describe, it, expect, beforeEach, vi } from "vitest";

// scripts/access-log.ts talks to prod/dev D1 only through node:child_process execFileSync →
// wrangler.sh — there is no exported runD1 or injectable runner (it's a private function baked
// into flushOrgKeyUses). The only seam available without editing scripts/ is mocking
// node:child_process itself, at the same external-command boundary the repo already mocks
// @simplewebauthn/server at in passkey-function.test.ts. This captures every SQL string the
// module would have sent to wrangler, so the assertions below never spawn a real process.
const execFileSyncMock = vi.fn<(...args: unknown[]) => string>();
vi.mock("node:child_process", () => ({ execFileSync: (...args: unknown[]) => execFileSyncMock(...args) }));

const { recordOrgKeyUse, flushOrgKeyUses } = await import("../../scripts/access-log");

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

beforeEach(async () => {
  delete process.env.ORG_ACCESS_LOG;
  // Drain whatever the previous test left buffered (module state is a singleton for the file)
  // before each test starts, so tests don't see each other's uses.
  mockLookup([]);
  await flushOrgKeyUses().catch(() => {});
  execFileSyncMock.mockClear();
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

  it("ORG_ACCESS_LOG=off skips the flush without touching wrangler", async () => {
    process.env.ORG_ACCESS_LOG = "off";
    recordOrgKeyUse({ clientId: "alex", purpose: "manual-decrypt" });

    await flushOrgKeyUses();

    expect(execFileSyncMock).not.toHaveBeenCalled();

    // Clean up: the buffered use survives the "off" flush (it's deferred, not dropped), so drain
    // it now with logging back on to avoid leaking into the next test.
    delete process.env.ORG_ACCESS_LOG;
    mockLookup([]);
    await flushOrgKeyUses();
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
