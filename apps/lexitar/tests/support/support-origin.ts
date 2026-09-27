/**
 * The recording fake origin the export principal's suites run against: a real support keypair, a real
 * content key per record, and each record's envelope really wrapped to that public key — so a run that
 * decrypts here would decrypt against the deployment, where a mock of the chain would pass whether or
 * not the chain is right.
 *
 * Shared because the two suites need the same origin for opposite reasons: support-export.test.ts pins
 * the requests that must be made, client-key-resolution.test.ts the ones that must not. A second copy
 * would drift from the routes it stands in for.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { Vault } from "../../src/lib/types";

export const BASE = "https://example.test";
export const SUPPORT_EMAIL = "record-cli@local.invalid";
// The literal the disk sweeps look for. A support principal's password may sit in a credentials file,
// so the one thing an export must never do is copy it into the exported record.
export const SUPPORT_PASSWORD = "n0t-1n-the-export-please";
const SALT_HEX = "a1".repeat(16);
export const OWNER = "owner-1";
export const OTHER = "owner-2";
// Everything /api/support/access returns about the person beyond the key: a name and an address.
// Neither may be printed or written.
export const OWNER_NAME = "Alex Bramble";
export const OWNER_EMAIL = "alex@example.test";
export const EXPIRES = "2026-10-04T00:00:00.000Z";

/** One record per owner, each keyed by a slug that is not its account id — the pasted-URL case. */
export const VAULTS: Record<string, Vault> = {
  [OWNER]: { clients: { alex: { id: "alex", displayName: "Alex" } as never }, rawKeys: { alex: {} } },
  [OTHER]: { clients: { blair: { id: "blair", displayName: "Blair" } as never }, rawKeys: { blair: {} } },
};
const RECORDS: Record<string, { vaultId: string; blobId: string }> = {
  [OWNER]: { vaultId: "vault-9", blobId: "blob-9" },
  [OTHER]: { vaultId: "vault-8", blobId: "blob-8" },
};

/** A live grant as `/api/support/owners` reports one. */
export const grant = (ownerAccountId: string) => ({ ownerAccountId, displayName: OWNER_NAME, expiresAt: EXPIRES });

interface Sealed {
  envelope: { wrappedDEK: string; ephemeralPublicKeyJwk: JsonWebKey };
  blob: Uint8Array;
}
let principal: { wrappedPrivateKey: string; authHash: string } | undefined;
const sealed: Record<string, Sealed> = {};

async function build(): Promise<void> {
  if (principal) return;
  const kek = await deriveKekFromPassword(SUPPORT_PASSWORD, hexToBytes(SALT_HEX));
  const keypair = await generateAccountKeypair();
  for (const [owner, vault] of Object.entries(VAULTS)) {
    const dek = await generateDEK();
    const env = await wrapDEKForPublicKey(dek, keypair.publicKeyJwk);
    sealed[owner] = {
      envelope: { wrappedDEK: bytesToB64(env.wrappedDEK), ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk },
      blob: await encryptVaultV2(vault, dek),
    };
  }
  principal = {
    wrappedPrivateKey: bytesToB64(await wrapPrivateKey(keypair.privateKey, kek)),
    authHash: await deriveAuthHash(SUPPORT_PASSWORD, hexToBytes(SALT_HEX)),
  };
}

export interface Over {
  /** The live grants `/api/support/owners` reports — the server has already dropped revoked and expired. */
  owners?: { ownerAccountId: string; displayName: string; expiresAt: string }[];
  requestStatus?: string;
  accessStatusFor?: Record<string, number>;
}

function origin(over: Over, sent: string[]) {
  const owners = over.owners ?? [grant(OWNER)];
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).slice(BASE.length);
    sent.push(`${init?.method ?? "GET"} ${url}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : null;
    const json = (status: number, b: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });

    if (url.startsWith("/api/auth/password/salt")) return json(200, { salt: SALT_HEX, iterations: 200_000 });
    if (url === "/api/auth/password/login") {
      if (body?.authHash !== principal!.authHash) return json(401, { error: "invalid credentials" });
      // A support principal owns no record: no vault, no r2Key, no envelope of its own.
      return json(
        200,
        {
          accountId: "support-1",
          vaultId: null,
          r2Key: null,
          rotationPending: false,
          wrappedPrivateKey: principal!.wrappedPrivateKey,
          kdfParams: { salt: SALT_HEX, iterations: 200_000 },
          ownerEnvelope: null,
        },
        { "set-cookie": "hd_session=tok-support; HttpOnly; Secure; Path=/" },
      );
    }
    if (url === "/api/support/owners") return json(200, { owners });
    if (url === "/api/support/request") return json(200, { ok: true, linkId: "link-1", status: over.requestStatus ?? "invited" });
    if (url === "/api/support/access") {
      const owner = String(body?.ownerAccountId);
      const status = over.accessStatusFor?.[owner];
      if (status) return json(status, { error: "no" });
      const record = RECORDS[owner];
      return json(200, {
        ownerAccountId: owner,
        displayName: OWNER_NAME,
        email: OWNER_EMAIL,
        vaultId: record.vaultId,
        r2Key: `data-${record.blobId}.enc`,
        envelope: sealed[owner].envelope,
      });
    }
    const blob = /^\/api\/vault\/(blob-\d+)$/.exec(url);
    if (blob) {
      const owner = Object.keys(RECORDS).find((o) => RECORDS[o].blobId === blob[1])!;
      return new Response(toArrayBuffer(sealed[owner].blob), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (/^\/api\/raw\/[^/?]+\?files=1$/.test(url)) return json(200, { files: [] });
    throw new Error(`unexpected request: ${url}`);
  };
}

export interface SupportCli {
  /** Every request the run made, `METHOD /path`, which is how "it opened nothing" is asserted. */
  readonly sent: string[];
  readonly out: string;
  readonly err: string;
  /** The export root, so a test can read what landed on disk. */
  readonly dir: string;
  /** Replace the origin mid-test. The default is one live grant, for OWNER. */
  use(over: Over): void;
}

/** Registers the hooks itself, so a suite is one `const cli = supportCli()` and nothing else. */
export function supportCli(): SupportCli {
  const state = { sent: [] as string[], printed: [] as string[], said: [] as string[], dir: "" };
  const realFetch = globalThis.fetch;
  const use = (over: Over) => void (globalThis.fetch = origin(over, state.sent) as typeof fetch);

  beforeEach(async () => {
    await build();
    state.sent = [];
    state.printed = [];
    state.said = [];
    state.dir = mkdtempSync(join(tmpdir(), "lexitar-export-test-"));
    vi.stubEnv("LEXITAR_SUPPORT_EMAIL", SUPPORT_EMAIL);
    vi.stubEnv("LEXITAR_SUPPORT_PASSWORD", SUPPORT_PASSWORD);
    vi.stubEnv("LEXITAR_BASE_URL", BASE);
    vi.stubEnv("LEXI_EXPORT_DIR", state.dir);
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      state.printed.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      state.said.push(String(s));
      return true;
    });
    use({});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    rmSync(state.dir, { recursive: true, force: true });
  });

  return {
    get sent() {
      return state.sent;
    },
    get out() {
      return state.printed.join("");
    },
    get err() {
      return state.said.join("");
    },
    get dir() {
      return state.dir;
    },
    use,
  };
}
