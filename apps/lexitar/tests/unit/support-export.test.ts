// The export CLI reading a record it does not own. What makes this safe is not the decryption — that is
// the same chain the owner path uses — but which records it will ask for at all, so most of what is
// pinned here is a request that must NOT be made.
//
// Same recording fake origin over real crypto as api-session.test.ts: the patient's vault is sealed with
// the primitives the browser seals it with and the envelope is wrapped to the support principal's real
// public key, so a run that decrypts here would decrypt against the deployment.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAuthHash,
  deriveKekFromPassword,
  encryptVaultV2,
  generateAccountKeypair,
  generateDEK,
  wrapDEKForPublicKey,
  wrapPrivateKey,
} from "@tinytars/vault/crypto";
import { toArrayBuffer } from "@tinytars/vault/bytes";
import { bytesToB64, hexToBytes } from "../../scripts/org-key";
import { listGrantedOwners, login, openGrantedVault, openVault, supportCredentials } from "../../scripts/api-session";
import { main } from "../../scripts/record-export";
import type { Vault } from "../../src/lib/types";

const BASE = "https://example.test";
const SUPPORT_EMAIL = "record-cli@local.invalid";
// The literal the disk sweep below looks for. A support principal's password may sit in a credentials
// file, so the one thing an export must never do is copy it into the exported record.
const SUPPORT_PASSWORD = "n0t-1n-the-export-please";
const SALT_HEX = "a1".repeat(16);
const OWNER = "owner-1";
const OTHER = "owner-2";
// Everything /api/support/access returns about the person beyond the key: a name, an address, and a
// label inside the record. None of the first two may be printed or written.
const OWNER_NAME = "Alex Bramble";
const OWNER_EMAIL = "alex@example.test";
const VAULT: Vault = {
  clients: { alex: { id: "alex", displayName: "Alex" } as never },
  rawKeys: { alex: {} },
};

interface Fixture {
  wrappedPrivateKey: string;
  envelope: { wrappedDEK: string; ephemeralPublicKeyJwk: JsonWebKey };
  blob: Uint8Array;
  authHash: string;
}
let fixture: Fixture;
let sent: string[] = [];
let printed: string[] = [];
let said: string[] = [];
let exportDir: string;
const realFetch = globalThis.fetch;

async function buildFixture(): Promise<Fixture> {
  const kek = await deriveKekFromPassword(SUPPORT_PASSWORD, hexToBytes(SALT_HEX));
  const principal = await generateAccountKeypair();
  const dek = await generateDEK();
  const env = await wrapDEKForPublicKey(dek, principal.publicKeyJwk);
  return {
    wrappedPrivateKey: bytesToB64(await wrapPrivateKey(principal.privateKey, kek)),
    envelope: { wrappedDEK: bytesToB64(env.wrappedDEK), ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk },
    blob: await encryptVaultV2(VAULT, dek),
    authHash: await deriveAuthHash(SUPPORT_PASSWORD, hexToBytes(SALT_HEX)),
  };
}

type Over = {
  /** The live grants /api/support/owners reports — the server has already dropped revoked and expired. */
  owners?: { ownerAccountId: string; displayName: string; expiresAt: string }[];
  requestStatus?: string;
  accessStatusFor?: Record<string, number>;
};

function origin(over: Over = {}) {
  const owners = over.owners ?? [{ ownerAccountId: OWNER, displayName: OWNER_NAME, expiresAt: "2026-10-04T00:00:00.000Z" }];
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).slice(BASE.length);
    sent.push(`${init?.method ?? "GET"} ${url}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : null;
    const json = (status: number, b: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });

    if (url.startsWith("/api/auth/password/salt")) return json(200, { salt: SALT_HEX, iterations: 200_000 });
    if (url === "/api/auth/password/login") {
      if (body?.authHash !== fixture.authHash) return json(401, { error: "invalid credentials" });
      // A support principal owns no record: no vault, no r2Key, no envelope of its own.
      return json(
        200,
        {
          accountId: "support-1",
          vaultId: null,
          r2Key: null,
          rotationPending: false,
          wrappedPrivateKey: fixture.wrappedPrivateKey,
          kdfParams: { salt: SALT_HEX, iterations: 200_000 },
          ownerEnvelope: null,
        },
        { "set-cookie": "hd_session=tok-support; HttpOnly; Secure; Path=/" },
      );
    }
    if (url === "/api/support/owners") return json(200, { owners });
    if (url === "/api/support/request") return json(200, { ok: true, linkId: "link-1", status: over.requestStatus ?? "invited" });
    if (url === "/api/support/access") {
      const status = over.accessStatusFor?.[String(body?.ownerAccountId)];
      if (status) return json(status, { error: "no" });
      return json(200, {
        ownerAccountId: body!.ownerAccountId,
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        vaultId: "vault-9",
        r2Key: "data-blob-9.enc",
        envelope: fixture.envelope,
      });
    }
    if (url === "/api/vault/blob-9")
      return new Response(toArrayBuffer(fixture.blob), { status: 200, headers: { "content-type": "application/octet-stream" } });
    if (url.startsWith("/api/raw/alex?files=1")) return json(200, { files: [] });
    throw new Error(`unexpected request: ${url}`);
  };
}

const asSupport = () => login(supportCredentials());

beforeEach(async () => {
  fixture ??= await buildFixture();
  sent = [];
  printed = [];
  said = [];
  exportDir = mkdtempSync(join(tmpdir(), "lexitar-export-test-"));
  vi.stubEnv("LEXITAR_SUPPORT_EMAIL", SUPPORT_EMAIL);
  vi.stubEnv("LEXITAR_SUPPORT_PASSWORD", SUPPORT_PASSWORD);
  vi.stubEnv("LEXITAR_BASE_URL", BASE);
  vi.stubEnv("LEXI_EXPORT_DIR", exportDir);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    printed.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    said.push(String(s));
    return true;
  });
  globalThis.fetch = origin() as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  rmSync(exportDir, { recursive: true, force: true });
});

describe("supportCredentials", () => {
  it("refuses to run half-configured, because there is no human to prompt", () => {
    vi.stubEnv("LEXITAR_SUPPORT_PASSWORD", "");
    expect(() => supportCredentials()).toThrow(/LEXITAR_SUPPORT_PASSWORD/);
  });
});

describe("listGrantedOwners", () => {
  it("keeps the account id and the expiry and drops the name", async () => {
    const owners = await listGrantedOwners(await asSupport());
    expect(owners).toEqual([{ ownerAccountId: OWNER, expiresAt: "2026-10-04T00:00:00.000Z" }]);
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
    globalThis.fetch = origin({ accessStatusFor: { [OWNER]: 403 } }) as typeof fetch;
    await expect(openGrantedVault(await asSupport(), OWNER)).rejects.toThrow(/no live approval.*approve.*revoked/s);
  });
});

describe("record:export as the support principal", () => {
  it("lists what is approved by account id and expiry alone", async () => {
    await main(["--list"]);
    expect(printed.join("")).toContain(`${OWNER} · until 2026-10-04T00:00:00.000Z`);
    expect(printed.join("")).not.toContain(OWNER_NAME);
  });

  it("exports the approved record and names its owner in the manifest", async () => {
    await main(["--patient", OWNER]);
    const dir = join(exportDir, readdirSync(exportDir)[0]);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.accountId).toBe(OWNER);
    expect(manifest.vaultId).toBe("vault-9");
    expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))).toEqual(VAULT.clients.alex);
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
    walk(exportDir);
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
    expect(sent).toContain("GET /api/support/owners");
    expect(sent).not.toContain("POST /api/support/access");
  });

  it("does not report an existing link as success, because active is not live", async () => {
    globalThis.fetch = origin({ requestStatus: "active" }) as typeof fetch;
    await main(["--request", OWNER_EMAIL]);
    const stderr = said.join("");
    expect(stderr).toMatch(/not proof that it is live/);
    expect(stderr).toMatch(/1\. they press Revoke/);
    expect(stderr).toMatch(/2\. re-run --request/);
    expect(sent).toContain("POST /api/support/request");
    expect(sent).not.toContain("POST /api/support/access");
  });

  it("says who must approve a fresh request and reads nothing", async () => {
    await main(["--request", OWNER_EMAIL]);
    expect(said.join("")).toMatch(/nothing is readable until they approve it/);
    expect(said.join("")).toMatch(/7 days/);
  });

  it("skips a record it cannot open under --all and still exits non-zero", async () => {
    globalThis.fetch = origin({
      owners: [
        { ownerAccountId: OWNER, displayName: OWNER_NAME, expiresAt: "2026-10-04T00:00:00.000Z" },
        { ownerAccountId: OTHER, displayName: "Blair", expiresAt: "2026-10-04T00:00:00.000Z" },
      ],
      accessStatusFor: { [OTHER]: 500 },
    }) as typeof fetch;
    await expect(main(["--all", "--dry-run"])).rejects.toThrow(/1 of 2 record\(s\) could not be exported/);
    expect(printed.join("")).toContain("0 documents would be fetched for alex");
    expect(said.join("")).toContain(`skipped ${OTHER}`);
  });
});
