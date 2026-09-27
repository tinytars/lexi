// api-session.ts is the CLI's whole route into an encrypted record, so what it must never do is as
// load-bearing as what it does: the raw passphrase must not leave the process, and a failure must
// name a cause an operator can act on.
//
// The fake origin below is a recording proxy over the REAL crypto — the fixture is built with the
// same primitives signup uses, so a vault sealed here must open through the module under test. A
// mock of the chain would pass whether or not the chain is right.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import {
  login,
  openVault,
  authedFetch,
  cliCredentials,
} from "../../scripts/api-session";
import type { Vault } from "../../src/lib/types";

const BASE = "https://example.test";
const EMAIL = "patient@example.test";
const PASSWORD = "correct horse battery staple";
const SALT_HEX = "0f".repeat(16);
const VAULT: Vault = {
  clients: { alpha: { id: "alpha", displayName: "Alpha" } as never },
  rawKeys: { alpha: {} },
};

interface Fixture {
  wrappedPrivateKey: string;
  ownerEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: JsonWebKey };
  blob: Uint8Array;
  authHash: string;
}
let fixture: Fixture;
let sent: { url: string; body: unknown; cookie: string | undefined }[] = [];
const realFetch = globalThis.fetch;

async function buildFixture(): Promise<Fixture> {
  const kek = await deriveKekFromPassword(PASSWORD, hexToBytes(SALT_HEX));
  const kp = await generateAccountKeypair();
  const dek = await generateDEK();
  const env = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  return {
    wrappedPrivateKey: bytesToB64(await wrapPrivateKey(kp.privateKey, kek)),
    ownerEnvelope: {
      wrappedDEK: bytesToB64(env.wrappedDEK),
      ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk,
    },
    blob: await encryptVaultV2(VAULT, dek),
    authHash: await deriveAuthHash(PASSWORD, hexToBytes(SALT_HEX)),
  };
}

type Over = {
  loginBody?: Record<string, unknown>;
  saltHtml?: boolean;
  vaultStatus?: number;
};

function origin(over: Over = {}) {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    sent.push({
      url,
      body,
      cookie: (init?.headers as Record<string, string> | undefined)?.cookie,
    });
    const json = (
      status: number,
      b: unknown,
      headers: Record<string, string> = {},
    ) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });

    if (url.startsWith(`${BASE}/api/auth/password/salt`)) {
      if (over.saltHtml)
        return new Response("<!doctype html><title>Sign in</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      return json(200, { salt: SALT_HEX, iterations: 200_000 });
    }
    if (url === `${BASE}/api/auth/password/login`) {
      if (body?.authHash !== fixture.authHash)
        return json(401, { error: "invalid credentials" });
      return json(
        200,
        {
          accountId: "acct-1",
          vaultId: "vault-1",
          r2Key: "data-blob-1.enc",
          rotationPending: false,
          wrappedPrivateKey: fixture.wrappedPrivateKey,
          kdfParams: { salt: SALT_HEX, iterations: 200_000 },
          ownerEnvelope: fixture.ownerEnvelope,
          ...over.loginBody,
        },
        {
          "set-cookie":
            "hd_session=tok-abc; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
        },
      );
    }
    if (url === `${BASE}/api/vault/blob-1`) {
      if (over.vaultStatus)
        return new Response("nope", { status: over.vaultStatus });
      return new Response(toArrayBuffer(fixture.blob), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

const creds = (password = PASSWORD) => ({
  baseUrl: BASE,
  email: EMAIL,
  password,
});

beforeEach(async () => {
  fixture ??= await buildFixture();
  sent = [];
  globalThis.fetch = origin() as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("login", () => {
  it("sends the auth hash and never the passphrase", async () => {
    await login(creds());
    const posted = sent.find((s) => s.url.endsWith("/login"))!;
    expect(posted.body).toEqual({ email: EMAIL, authHash: fixture.authHash });
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);
  });

  it("captures the session cookie", async () => {
    expect((await login(creds())).cookie).toBe("hd_session=tok-abc");
  });

  it("names every cause of a 401, because the server returns one status for all of them", async () => {
    await expect(login(creds("wrong"))).rejects.toThrow(
      /password is wrong.*address is unknown.*passkey-only/s,
    );
  });

  it("blames Cloudflare Access when the origin answers HTML instead of JSON", async () => {
    globalThis.fetch = origin({ saltHtml: true }) as typeof fetch;
    await expect(login(creds())).rejects.toThrow(/Cloudflare Access/);
  });
});

describe("authedFetch", () => {
  it("replays the cookie on the next request", async () => {
    const session = await login(creds());
    await authedFetch(session, "/api/vault/blob-1");
    expect(sent.at(-1)!.cookie).toBe("hd_session=tok-abc");
  });
});

describe("openVault", () => {
  it("decrypts the vault the session is entitled to", async () => {
    const open = await openVault(await login(creds()));
    expect(open.vault.clients.alpha.displayName).toBe("Alpha");
    expect(open.blobId).toBe("blob-1");
    expect(open.vaultId).toBe("vault-1");
  });

  it("surfaces a pending re-key rather than reading past it", async () => {
    globalThis.fetch = origin({
      loginBody: { rotationPending: true },
    }) as typeof fetch;
    expect((await openVault(await login(creds()))).rotationPending).toBe(true);
  });

  it("refuses an account that holds no vault", async () => {
    globalThis.fetch = origin({
      loginBody: { vaultId: null, r2Key: null, ownerEnvelope: null },
    }) as typeof fetch;
    await expect(openVault(await login(creds()))).rejects.toThrow(
      /no vault to export/,
    );
  });

  it("reports a passphrase that cannot open the account key as a credential failure", async () => {
    const session = await login(creds());
    await expect(
      openVault({ ...session, password: "not the passphrase" }),
    ).rejects.toThrow(/does not open its account key/);
  });

  it("reports an unreadable vault blob with its status", async () => {
    globalThis.fetch = origin({ vaultStatus: 403 }) as typeof fetch;
    await expect(openVault(await login(creds()))).rejects.toThrow(
      /cannot read vault blob-1 \(403\)/,
    );
  });
});

describe("cliCredentials", () => {
  it("defaults to the local dev origin so no default run reads a deployment", () => {
    vi.stubEnv("LEXITAR_CLI_EMAIL", EMAIL);
    vi.stubEnv("LEXITAR_CLI_PASSWORD", PASSWORD);
    vi.stubEnv("LEXITAR_BASE_URL", "");
    expect(cliCredentials().baseUrl).toBe("http://localhost:8788");
  });

  it("refuses to guess a missing credential", () => {
    vi.stubEnv("LEXITAR_CLI_EMAIL", "");
    vi.stubEnv("LEXITAR_CLI_PASSWORD", "");
    expect(() => cliCredentials()).toThrow(/plover-keys\/health-dash.env/);
  });
});
