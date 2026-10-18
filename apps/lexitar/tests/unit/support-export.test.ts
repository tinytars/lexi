// The export CLI reading a record it does not own. What makes this safe is not the decryption — that is
// the same chain the owner path uses — but which records it will ask for at all, so most of what is
// pinned here is a request that must NOT be made.
//
// The fake origin is tests/support/support-origin.ts: real crypto, and every request recorded.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listGrantedOwners, login, openGrantedVault, openVault, supportCredentials } from "../../scripts/api-session";
import { main } from "../../scripts/record-export";
import {
  EXPIRES,
  grant,
  OTHER,
  OWNER,
  OWNER_EMAIL,
  OWNER_NAME,
  SUPPORT_PASSWORD,
  supportCli,
  VAULTS,
} from "../support/support-origin";

const cli = supportCli();
const asSupport = () => login(supportCredentials());

describe("supportCredentials", () => {
  it("refuses to run half-configured, because there is no human to prompt", () => {
    vi.stubEnv("LEXITAR_SUPPORT_PASSWORD", "");
    expect(() => supportCredentials()).toThrow(/LEXITAR_SUPPORT_PASSWORD/);
  });
});

describe("listGrantedOwners", () => {
  it("keeps the account id and the expiry and drops the name", async () => {
    const owners = await listGrantedOwners(await asSupport());
    expect(owners).toEqual([{ ownerAccountId: OWNER, expiresAt: EXPIRES }]);
    expect(JSON.stringify(owners)).not.toContain(OWNER_NAME);
  });
});

describe("openGrantedVault", () => {
  it("decrypts the patient's record from the envelope the grant handed over", async () => {
    const open = await openGrantedVault(await asSupport(), OWNER);
    expect(open.vault.clients.alex.displayName).toBe("Alex");
    expect(open.blobId).toBe("blob-9");
    expect(open.vaultId).toBe("vault-9");
  });

  it("reports the record's owner as the subject, not the principal that read it", async () => {
    expect((await openGrantedVault(await asSupport(), OWNER)).accountId).toBe(OWNER);
  });

  it("opens a record although the principal owns none, while the owner path still refuses", async () => {
    const session = await asSupport();
    await expect(openGrantedVault(session, OWNER)).resolves.toBeTruthy();
    await expect(openVault(session)).rejects.toThrow(/no vault to export/);
  });

  it("names the approval as the missing thing when the route refuses", async () => {
    cli.use({ accessStatusFor: { [OWNER]: 403 } });
    await expect(openGrantedVault(await asSupport(), OWNER)).rejects.toThrow(/no live approval.*approve.*revoked/s);
  });
});

describe("record:export as the support principal", () => {
  it("lists what is approved by account id and expiry alone", async () => {
    await main(["--list"]);
    expect(cli.out).toContain(`${OWNER} · until ${EXPIRES}`);
    expect(cli.out).not.toContain(OWNER_NAME);
  });

  it("exports the approved record and names its owner in the manifest", async () => {
    await main(["--patient", OWNER]);
    const dir = join(cli.dir, readdirSync(cli.dir)[0]);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.accountId).toBe(OWNER);
    expect(manifest.vaultId).toBe("vault-9");
    expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))).toEqual(VAULTS[OWNER].clients.alex);
  });

  // The principal's password may sit in a credentials file, and the patient's name and address arrive
  // with every grant. None of the three is part of the record, so none may land in the export.
  it("writes neither the principal's password nor the patient's identity to disk", async () => {
    await main(["--patient", OWNER]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        statSync(full).isDirectory() ? walk(full) : files.push(readFileSync(full, "utf8"));
      }
    };
    walk(cli.dir);
    expect(files.length).toBeGreaterThan(0);
    for (const contents of files) {
      expect(contents).not.toContain(SUPPORT_PASSWORD);
      expect(contents).not.toContain(OWNER_NAME);
      expect(contents).not.toContain(OWNER_EMAIL);
    }
  });

  // The expensive mistake this flag exists to prevent: opening a lapsed grant deletes its envelope and
  // sets rotation_pending, re-keying that patient's whole record at their next sign-in.
  it("asks for no record that is not on the approved list", async () => {
    await expect(main(["--patient", OTHER])).rejects.toThrow(/has not approved this tool.*--request/s);
    expect(cli.sent).toContain("GET /api/support/owners");
    expect(cli.sent).not.toContain("POST /api/support/access");
  });

  it("does not report an existing link as success, because active is not live", async () => {
    cli.use({ requestStatus: "active" });
    await main(["--request", OWNER_EMAIL]);
    expect(cli.err).toMatch(/not proof that it is live/);
    expect(cli.err).toMatch(/1\. they press Revoke/);
    expect(cli.err).toMatch(/2\. re-run --request/);
    expect(cli.sent).toContain("POST /api/support/request");
    expect(cli.sent).not.toContain("POST /api/support/access");
  });

  it("says who must approve a fresh request and reads nothing", async () => {
    await main(["--request", OWNER_EMAIL]);
    expect(cli.err).toMatch(/nothing is readable until they approve it/);
    expect(cli.err).toMatch(/7 days/);
  });

  it("skips a record it cannot open under --all and still exits non-zero", async () => {
    cli.use({ owners: [grant(OWNER), grant(OTHER)], accessStatusFor: { [OTHER]: 500 } });
    await expect(main(["--all", "--dry-run"])).rejects.toThrow(/1 of 2 record\(s\) could not be exported/);
    expect(cli.out).toContain("0 documents would be fetched for alex");
    expect(cli.err).toContain(`skipped ${OTHER}`);
  });
});
