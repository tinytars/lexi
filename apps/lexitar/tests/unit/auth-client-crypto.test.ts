import { describe, it, expect, beforeEach, vi } from "vitest";
import { signupPassword, loginPassword } from "@tinytars/vault/auth-client";
import {
  generateAccountKeypair,
  deriveKekFromPassword,
  unwrapPrivateKey,
  unwrapDEKWithPrivateKey,
  decryptVaultV2,
  deriveAuthHash,
} from "@tinytars/vault/crypto";

// W71 — auth-client.ts is 706 lines and had no tests, while its server counterparts do: the suite
// looked green over a path where only one half was verified.
//
// What is asserted here is the CLIENT CRYPTO CONTRACT — what actually leaves the browser during
// signup and sign-in. That is the whole security model of this application: the server is supposed to
// be unable to read a patient's record, and the only thing making that true is what these functions
// put on the wire. A regression here does not throw; it silently ships a vault the operator can open.
//
// Verified by DECRYPTING the payload rather than by inspecting its shape, so a change that keeps the
// field names and breaks the cryptography fails.

const hexToBytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

interface SignupBody {
  email: string;
  displayName: string;
  publicKeyJwk: JsonWebKey;
  wrappedPrivateKey: string;
  kdfParams: { salt: string; iterations: number };
  authHash: string;
  vaultBlob: string;
  ownerEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: JsonWebKey };
  orgEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: JsonWebKey };
}

let orgKeypair: Awaited<ReturnType<typeof generateAccountKeypair>>;
let captured: { url: string; body: unknown }[] = [];

/** A fake server that records what the browser sent and answers plausibly. */
function server(over: Record<string, (body: never) => unknown> = {}) {
  captured = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({ url, body });
    const path = url.split("?")[0];
    const custom = over[path];
    if (custom) return new Response(JSON.stringify(custom(body as never)), { status: 200 });
    if (path === "/api/vault/org-key") {
      return new Response(JSON.stringify({ orgAccountId: "org", orgPublicKeyJwk: orgKeypair.publicKeyJwk }), { status: 200 });
    }
    if (path === "/api/auth/password/signup") {
      return new Response(JSON.stringify({ accountId: "acc-1", vaultId: "v-1" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

const signupBody = () => captured.find((c) => c.url.includes("/signup"))!.body as SignupBody;

beforeEach(async () => {
  vi.unstubAllGlobals();
  orgKeypair = await generateAccountKeypair();
});

describe("signup puts nothing the server could read on the wire", () => {
  const PASSWORD = "correct horse battery staple";

  it("never sends the password itself, in any field", async () => {
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    const serialized = JSON.stringify(signupBody());
    expect(serialized).not.toContain(PASSWORD);
    // Nor a trivially reversible encoding of it.
    expect(serialized).not.toContain(btoa(PASSWORD));
  });

  it("sends an authHash that is not the password and is bound to the salt", async () => {
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    const b = signupBody();
    expect(b.authHash).not.toBe(PASSWORD);
    // Derivable from the password AND the salt the server was given — that pairing is what makes it
    // useless to anyone who steals the database without the password.
    expect(b.authHash).toBe(await deriveAuthHash(PASSWORD, hexToBytes(b.kdfParams.salt)));
    expect(b.authHash).not.toBe(await deriveAuthHash("wrong password", hexToBytes(b.kdfParams.salt)));
  });

  it("sends a private key the RIGHT password opens and the wrong one does not", async () => {
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    const b = signupBody();
    const salt = hexToBytes(b.kdfParams.salt);

    const good = await deriveKekFromPassword(PASSWORD, salt);
    await expect(unwrapPrivateKey(b64ToBytes(b.wrappedPrivateKey), good)).resolves.toBeTruthy();

    const bad = await deriveKekFromPassword("wrong password", salt);
    await expect(unwrapPrivateKey(b64ToBytes(b.wrappedPrivateKey), bad)).rejects.toBeTruthy();
  });

  it("sends the vault as ciphertext that opens only via the owner's envelope", async () => {
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    const b = signupBody();

    const blob = b64ToBytes(b.vaultBlob);
    expect([blob[0], blob[1], blob[2]]).toEqual([0x48, 0x44, 0x31]); // "HD1"
    // Not the plaintext it started as.
    expect(new TextDecoder().decode(blob)).not.toContain("clients");

    const privateKey = await unwrapPrivateKey(
      b64ToBytes(b.wrappedPrivateKey),
      await deriveKekFromPassword(PASSWORD, hexToBytes(b.kdfParams.salt)),
    );
    const dek = await unwrapDEKWithPrivateKey(
      b64ToBytes(b.ownerEnvelope.wrappedDEK),
      b.ownerEnvelope.ephemeralPublicKeyJwk,
      privateKey,
    );
    await expect(decryptVaultV2(blob, dek)).resolves.toEqual({ clients: {} });
  });

  it("wraps the SAME dek to the org as well, or recovery is impossible", async () => {
    // W55 — the org envelope is the only route back in for a patient who loses their password. A
    // signup that omitted it, or wrapped a different key, would look completely healthy until the day
    // it mattered.
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    const b = signupBody();
    expect(b.orgEnvelope).toBeTruthy();

    const orgDek = await unwrapDEKWithPrivateKey(
      b64ToBytes(b.orgEnvelope.wrappedDEK),
      b.orgEnvelope.ephemeralPublicKeyJwk,
      orgKeypair.privateKey,
    );
    await expect(decryptVaultV2(b64ToBytes(b.vaultBlob), orgDek)).resolves.toEqual({ clients: {} });
  });

  it("uses a fresh salt and a fresh keypair per signup", async () => {
    server();
    await signupPassword("a@x.test", "A", PASSWORD);
    const first = signupBody();
    server();
    await signupPassword("b@x.test", "B", PASSWORD);
    const second = signupBody();

    // Same password, different salt — or two accounts share an authHash and a KEK.
    expect(second.kdfParams.salt).not.toBe(first.kdfParams.salt);
    expect(second.authHash).not.toBe(first.authHash);
    expect(JSON.stringify(second.publicKeyJwk)).not.toBe(JSON.stringify(first.publicKeyJwk));
  });

  it("asks for a real iteration count, not a placeholder", async () => {
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    expect(signupBody().kdfParams.iterations).toBeGreaterThanOrEqual(100_000);
  });
});

describe("login derives from the salt the server hands back", () => {
  const PASSWORD = "correct horse battery staple";

  it("sends an authHash matching the one signup stored, and never the password", async () => {
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    const stored = signupBody();

    const kp = await generateAccountKeypair();
    server({
      "/api/auth/password/salt": () => ({ salt: stored.kdfParams.salt, iterations: stored.kdfParams.iterations }),
      "/api/auth/password/login": () => ({
        accountId: "acc-1",
        vaultId: "v-1",
        r2Key: "data-acc-1.enc",
        wrappedPrivateKey: stored.wrappedPrivateKey,
        kdfParams: stored.kdfParams,
        ownerEnvelope: stored.ownerEnvelope,
        rotationPending: false,
      }),
    });
    void kp;

    await loginPassword("p@x.test", PASSWORD).catch(() => {});
    const login = captured.find((c) => c.url.includes("/password/login"))!.body as { email: string; authHash: string };
    expect(login.authHash).toBe(stored.authHash);
    expect(JSON.stringify(login)).not.toContain(PASSWORD);
  });

  it("a wrong password produces a different authHash — the server is never asked to compare secrets", async () => {
    server();
    await signupPassword("p@x.test", "Alex", PASSWORD);
    const stored = signupBody();

    server({
      "/api/auth/password/salt": () => ({ salt: stored.kdfParams.salt, iterations: stored.kdfParams.iterations }),
      "/api/auth/password/login": () => ({}),
    });
    await loginPassword("p@x.test", "not the password").catch(() => {});
    const login = captured.find((c) => c.url.includes("/password/login"))!.body as { authHash: string };
    expect(login.authHash).not.toBe(stored.authHash);
  });
});
