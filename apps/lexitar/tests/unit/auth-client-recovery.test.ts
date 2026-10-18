// W75 item 13 — the recovery, rotation and login-method half of auth-client.ts. See
// auth-client-grants.test.ts's header for why this is three files.
//
// The centre of this file is a REAL round trip: a clinician issues a recovery code from a patient
// envelope, and the patient redeems that exact code and gets back a DEK that opens the vault sealed
// before any of it happened. Both halves ran only in a browser and neither was asserted anywhere —
// the code wraps the vault DEK, so a defect here is either a locked-out patient or a key handed to
// the wrong person, and both fail silently.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  issueRecoveryCode,
  redeemRecoveryCode,
  normalizeGrantCode,
  randomGrantCode,
  detectRecoveryKind,
  getVaultPrincipals,
  stageVaultRotation,
  rotateVault,
  regenerateRecoveryCode,
  putRecoveryEnvelope,
  revokeRecoveryEnvelope,
  getAccessEvents,
  listMethods,
  removeMethod,
  updateProfile,
  addPasswordMethod,
  recoverAccount,
} from "@tinytars/vault/auth-recovery";
import {
  generateAccountKeypair,
  generateDEK,
  wrapDEKForPublicKey,
  encryptVaultV2,
  decryptVaultV2,
  deriveAuthHash,
} from "@tinytars/vault/crypto";

const bytesToBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const hexToBytes = (h: string) => new Uint8Array(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));

interface Sent { url: string; method: string; body: any }
let sent: Sent[] = [];
let respond: (url: string, body: any) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

const json = (status: number, b: unknown) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sent = [];
  respond = () => json(200, {});
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : null;
    sent.push({ url, method: init?.method ?? "GET", body });
    return respond(url, body);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the grant code itself", () => {
  it("is displayed grouped and compared ungrouped, so a patient may type it either way", () => {
    const code = randomGrantCode();
    expect(code).toMatch(/^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/);
    expect(normalizeGrantCode(code)).toBe(code.replace(/-/g, "").toUpperCase());
    expect(normalizeGrantCode("a7k2-9qmf-3xpb")).toBe(normalizeGrantCode("A7K2 9QMF 3XPB"));
  });

  it("is not the same code twice", () => {
    expect(randomGrantCode()).not.toBe(randomGrantCode());
  });
});

describe("detecting which rung a typed code belongs to", () => {
  // W80 — the lock screen no longer asks which kind of code someone is holding; it reads the shape
  // instead. A self-service code is always 20 raw characters, a grant code always 12 (grouped for
  // display) — the two lengths never collide, so the stripped length alone is enough to route.
  it("reads a 20-character self-service code as \"code\"", () => {
    expect(detectRecoveryKind("A".repeat(20))).toBe("code");
  });

  it("reads a grouped or ungrouped 12-character grant code as \"grant\", case-insensitively", () => {
    const code = randomGrantCode();
    expect(detectRecoveryKind(code)).toBe("grant");
    expect(detectRecoveryKind(code.replace(/-/g, ""))).toBe("grant");
    expect(detectRecoveryKind(code.toLowerCase())).toBe("grant");
  });

  it("defaults an empty or in-between-length string to \"code\", never a false grant match", () => {
    expect(detectRecoveryKind("")).toBe("code");
    expect(detectRecoveryKind("A".repeat(11))).toBe("code");
    expect(detectRecoveryKind("A".repeat(13))).toBe("code");
  });
});

describe("clinician issues → patient redeems", () => {
  it("hands over a DEK that opens the vault, without either side sending the code or a key", async () => {
    // The world before the patient forgot anything: a vault sealed under a DEK, and a clinician
    // holding an envelope for it (which is what provider access already is).
    const clinician = await generateAccountKeypair();
    const dek = await generateDEK();
    const sealed = await encryptVaultV2({ ldl: 120 }, dek);
    const env = await wrapDEKForPublicKey(dek, clinician.publicKeyJwk);
    const envelope = { wrappedDEK: bytesToBase64(env.wrappedDEK), ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk };

    // A server that keeps exactly what the real one keeps for a grant.
    let grant: { wrappedDek: string; salt: string; codeAuthHash: string } | null = null;
    respond = (url, body) => {
      if (url === "/api/recovery/grant") {
        grant = { wrappedDek: body.wrappedDek, salt: body.kdfParams.salt, codeAuthHash: body.codeAuthHash };
        return json(200, { expiresAt: "2026-09-01T00:00:00.000Z" });
      }
      if (url.startsWith("/api/auth/recovery/grant-salt")) return json(200, { salt: grant!.salt });
      if (url === "/api/auth/recovery/grant-redeem") {
        if (body.codeAuthHash !== grant!.codeAuthHash) return json(401, { error: "that code is not valid" });
        return body.newIdentity
          ? json(200, { accountId: "acct-1", vaultId: "v1", r2Key: "data-v1.enc", rotationPending: false })
          : json(200, { wrappedDek: grant!.wrappedDek });
      }
      return json(404, {});
    };

    const { code, expiresAt } = await issueRecoveryCode("patient-1", envelope, clinician.privateKey);
    expect(expiresAt).toBe("2026-09-01T00:00:00.000Z");

    const out = await redeemRecoveryCode("patient@example.com", code, "a brand new password");
    expect(await decryptVaultV2(sealed, out.dek)).toEqual({ ldl: 120 });
    expect(out.accountId).toBe("acct-1");

    // Nothing on the wire is the code, the password, or a key.
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(normalizeGrantCode(code));
    expect(wire).not.toContain(code);
    expect(wire).not.toContain("a brand new password");
  });

  it("proves the code on BOTH redeem calls — the second is not authorised by the first having happened", async () => {
    const clinician = await generateAccountKeypair();
    const dek = await generateDEK();
    const env = await wrapDEKForPublicKey(dek, clinician.publicKeyJwk);
    let grant: any = null;
    respond = (url, body) => {
      if (url === "/api/recovery/grant") {
        grant = body;
        return json(200, { expiresAt: "x" });
      }
      if (url.startsWith("/api/auth/recovery/grant-salt")) return json(200, { salt: grant.kdfParams.salt });
      return body.newIdentity
        ? json(200, { accountId: "a", vaultId: null, r2Key: null, rotationPending: false })
        : json(200, { wrappedDek: grant.wrappedDek });
    };
    const { code } = await issueRecoveryCode("p", { wrappedDEK: bytesToBase64(env.wrappedDEK), ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk }, clinician.privateKey);
    await redeemRecoveryCode("p@example.com", code, "new one");

    const redeems = sent.filter((s) => s.url === "/api/auth/recovery/grant-redeem");
    expect(redeems).toHaveLength(2);
    expect(redeems[0].body.codeAuthHash).toBe(redeems[1].body.codeAuthHash);
    expect(redeems[0].body.newIdentity).toBeUndefined();
  });

  it("installs a NEW keypair locked under the new password, because the old private key is what was lost", async () => {
    const clinician = await generateAccountKeypair();
    const dek = await generateDEK();
    const env = await wrapDEKForPublicKey(dek, clinician.publicKeyJwk);
    let grant: any = null;
    respond = (url, body) => {
      if (url === "/api/recovery/grant") {
        grant = body;
        return json(200, { expiresAt: "x" });
      }
      if (url.startsWith("/api/auth/recovery/grant-salt")) return json(200, { salt: grant.kdfParams.salt });
      return body.newIdentity
        ? json(200, { accountId: "a", vaultId: null, r2Key: null, rotationPending: false })
        : json(200, { wrappedDek: grant.wrappedDek });
    };
    const { code } = await issueRecoveryCode("p", { wrappedDEK: bytesToBase64(env.wrappedDEK), ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk }, clinician.privateKey);
    const out = await redeemRecoveryCode("p@example.com", code, "new one");

    const identity = sent.filter((s) => s.url === "/api/auth/recovery/grant-redeem")[1].body.newIdentity;
    expect(Object.keys(identity).sort()).toEqual(["authHash", "envelope", "kdfParams", "publicKeyJwk", "wrappedPrivateKey"]);
    // The authHash the server will store is the one derived from the NEW password and the NEW salt.
    expect(identity.authHash).toBe(await deriveAuthHash("new one", hexToBytes(identity.kdfParams.salt)));
    expect(out.privateKey).toBeDefined();
  });

  it("reports the server's own sentence for a wrong code, not a status number", async () => {
    respond = (url) =>
      url.startsWith("/api/auth/recovery/grant-salt") ? json(200, { salt: "00".repeat(16) }) : json(401, { error: "that code is not valid, or it has expired" });
    await expect(redeemRecoveryCode("p@example.com", "AAAA-BBBB-CCCC", "pw")).rejects.toThrow(/not valid, or it has expired/);
  });

  it("refuses to start when the grant salt cannot be fetched, rather than deriving against a guess", async () => {
    respond = () => json(503, {});
    await expect(redeemRecoveryCode("p@example.com", "AAAA-BBBB-CCCC", "pw")).rejects.toThrow(/recovery is unavailable right now \(503\)/);
  });
});

describe("vault re-key, from the client's side", () => {
  it("stages first and commits second, on the same endpoint, distinguished only by phase", async () => {
    respond = () => json(200, { newVaultId: "v2" });
    expect(await stageVaultRotation("v1")).toBe("v2");
    await rotateVault({ vaultId: "v1", newVaultId: "v2", envelopes: [{ principalAccountId: "me", wrappedDEK: "w", ephemeralPublicKeyJwk: {} }] });

    expect(sent.map((s) => s.url)).toEqual(["/api/vault/rotate", "/api/vault/rotate"]);
    expect(sent[0].body).toEqual({ phase: "stage", vaultId: "v1" });
    expect(sent[1].body.phase).toBe("commit");
    expect(sent[1].body.newVaultId).toBe("v2");
    expect(sent[1].body.envelopes).toHaveLength(1);
  });

  it("throws if the commit is refused — a rotation that half-happened must not read as done", async () => {
    respond = () => json(409, {});
    await expect(rotateVault({ vaultId: "v1", newVaultId: "v2", envelopes: [] })).rejects.toThrow(/rotate failed \(409\)/);
  });

  it("reads the principal set uncached — a stale provider list would drop somebody's envelope", async () => {
    respond = () => json(200, { selfAccountId: "me", providers: [] });
    await getVaultPrincipals();
    expect(sent[0].url).toBe("/api/vault/principals");
  });
});

describe("the org recovery envelope and the recovery credential", () => {
  it("regenerates a recovery code and sends only wrapped material and a hash", async () => {
    const kp = await generateAccountKeypair();
    const code = await regenerateRecoveryCode(kp.privateKey);
    expect(code.length).toBeGreaterThan(8);
    expect(Object.keys(sent[0].body).sort()).toEqual(["kdfParams", "recoveryAuthHash", "wrappedPrivateKey"]);
    expect(JSON.stringify(sent[0].body)).not.toContain(code);
    // The hash is the code against the salt that went with it — not against anything else.
    expect(sent[0].body.recoveryAuthHash).toBe(await deriveAuthHash(code, hexToBytes(sent[0].body.kdfParams.salt)));
  });

  it("puts and revokes the org envelope on one endpoint, by method", async () => {
    respond = (_u, body) => (body ? json(200, { status: "stored" }) : json(200, { status: "revoked", revokedAt: "2026-08-26" }));
    expect(await putRecoveryEnvelope({ wrappedDEK: "w", ephemeralPublicKeyJwk: {} })).toEqual({ status: "stored" });
    expect(await revokeRecoveryEnvelope()).toEqual({ status: "revoked", revokedAt: "2026-08-26" });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/vault/recovery-envelope",
      "DELETE /api/vault/recovery-envelope",
    ]);
  });
});

describe("login methods and the step-up proof", () => {
  it("derives the current-password proof against the CURRENT salt, not the new one", async () => {
    const currentSalt = "ab".repeat(16);
    respond = (url) => (url.startsWith("/api/auth/password/salt") ? json(200, { salt: currentSalt, iterations: 200_000 }) : json(200, {}));
    const kp = await generateAccountKeypair();
    await addPasswordMethod(kp.privateKey, "correct horse battery", "stapler tuesday rain", "me@example.com");

    const post = sent.find((s) => s.method === "POST")!;
    expect(post.body.currentAuthHash).toBe(await deriveAuthHash("stapler tuesday rain", hexToBytes(currentSalt)));
    // A proof derived against the NEW salt would match nothing — the exact bug this guards.
    expect(post.body.currentAuthHash).not.toBe(await deriveAuthHash("stapler tuesday rain", hexToBytes(post.body.kdfParams.salt)));
    expect(post.body.authHash).toBe(await deriveAuthHash("correct horse battery", hexToBytes(post.body.kdfParams.salt)));
    const wire = JSON.stringify(post.body);
    expect(wire).not.toContain("correct horse battery");
    expect(wire).not.toContain("stapler tuesday rain");
  });

  it("omits the proof entirely for an account that has no password to prove", async () => {
    const kp = await generateAccountKeypair();
    await addPasswordMethod(kp.privateKey, "first password");
    expect(sent.map((s) => s.url)).toEqual(["/api/account/methods"]); // no salt lookup at all
    expect(sent[0].body.currentAuthHash).toBeUndefined();
  });

  it("surfaces the server's 401 sentence, so 'wrong password' does not read as a server fault", async () => {
    respond = (url) =>
      url.startsWith("/api/auth/password/salt") ? json(200, { salt: "cd".repeat(16) }) : json(401, { error: "that password is not right" });
    const kp = await generateAccountKeypair();
    await expect(addPasswordMethod(kp.privateKey, "new", "wrong", "me@example.com")).rejects.toThrow(/that password is not right/);
  });

  it("lists, removes and patches through the account endpoints", async () => {
    respond = () => json(200, { methods: [{ method: "password", createdAt: "x", isRecovery: false }] });
    expect(await listMethods()).toHaveLength(1);
    await removeMethod("passkey");
    await updateProfile({ displayName: "New Name" });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/account/methods",
      "DELETE /api/account/methods",
      "PATCH /api/account",
    ]);
    expect(sent[1].body).toEqual({ method: "passkey" });
    expect(sent[2].body).toEqual({ displayName: "New Name" });
  });

  it("reads the access log uncached — an audit view showing a cached page is not an audit view", async () => {
    respond = () => json(200, { events: [{ id: "e1", action: "vault.read" }] });
    expect((await getAccessEvents()).events).toHaveLength(1);
    expect(sent[0].url).toBe("/api/account/access-events");
  });
});

describe("what someone locked out is told", () => {
  it("stays opaque when a recovery code is refused, however detailed the server was", async () => {
    // The tempting change is to surface the server's sentence here the way W76 does everywhere past
    // sign-in. It must not: redeeming a code is a PRE-authentication endpoint, so any reason is also
    // an answer about whether that address has a recovery credential — the oracle the decoy salt
    // exists to close. The cap W75 added is enforced server-side either way.
    respond = (url) =>
      url.startsWith("/api/auth/recovery/salt")
        ? json(200, { salt: "00", iterations: 1 })
        : json(429, { error: "no recovery credential for blair@example.com" });
    const err = (await recoverAccount("blair@example.com", "AAAA-BBBB-CCCC").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/recovery failed: 429/);
    expect(err.message).not.toContain("blair@example.com");
  });

  it("keeps the salt lookup opaque, because a decoy is returned for an unknown address", async () => {
    // Deliberately NOT routed through the server's message: any detail here would answer whether the
    // account exists, which the decoy exists to refuse.
    respond = (url) => (url.startsWith("/api/auth/recovery/salt") ? json(500, { error: "no recovery credential for blair@example.com" }) : json(200, {}));
    const err = await recoverAccount("blair@example.com", "AAAA-BBBB-CCCC").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/recovery is unavailable right now \(500\)/);
    expect((err as Error).message).not.toContain("blair@example.com");
  });

  it("reports a refused rotation commit with the server's reason, not as a bare conflict", async () => {
    respond = () => json(409, { error: "the vault moved while the re-key was staged" });
    await expect(rotateVault({ vaultId: "v1", newVaultId: "v2", envelopes: [] })).rejects.toThrow("the vault moved while the re-key was staged");
  });

  it("refuses to remove a login method with the server's reason — never leaving an account with no way in", async () => {
    respond = () => json(409, { error: "that is your only way to sign in" });
    await expect(removeMethod("password")).rejects.toThrow("that is your only way to sign in");
  });
});
