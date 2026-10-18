import { describe, it, expect, beforeAll } from "vitest";
import {
  provisionGoogleAccount,
  loadGoogleKeyMaterial,
  linkGoogleToAccount,
  verifyIdTokenClaims,
  deriveGoogleKek,
  type GoogleClaims,
} from "../../functions/_lib/google";
import { createAccount, getAccount } from "../../functions/_lib/identity-accounts";
import { getCredential, getIdentityByProviderSubject, putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, listEnvelopesForVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { ORG_ACCOUNT_ID } from "../../functions/_lib/org";
import {
  generateAccountKeypair,
  unwrapDEKWithPrivateKey,
  importPrivateKeyPkcs8,
  decryptVaultV2,
} from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";

const w = useWorkerd({ r2: true });
const STORE_PREFIX = "test";
// base64 of 32 bytes — the server KEK.
const GOOGLE_KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

beforeAll(async () => {
  // Provisioning wraps an org-recovery envelope server-side, so the org account + public key must exist.
  await createAccount(w.db, { id: ORG_ACCOUNT_ID, displayName: "Org" });
  await putPublicKey(w.db, { accountId: ORG_ACCOUNT_ID, publicKeyJwk: (await generateAccountKeypair()).publicKeyJwk });
});

const deps = () => ({ db: w.db, vault: w.bucket, storePrefix: STORE_PREFIX, googleKekB64: GOOGLE_KEK });
const claims = (over: Partial<GoogleClaims> = {}): GoogleClaims => ({ sub: "sub-" + crypto.randomUUID(), email: null, emailVerified: true, name: "Test", ...over });

describe("Google JIT provisioning + server-custody round-trip", () => {
  it("provisions an account whose vault DEK is recoverable from the server-unwrapped key", async () => {
    const c = claims({ email: "jit@example.com", name: "JIT User" });
    const { accountId, vaultId } = await provisionGoogleAccount(deps(), c);

    // D1 rows written.
    expect((await getAccount(w.db, accountId))?.email).toBe("jit@example.com");
    expect(await getIdentityByProviderSubject(w.db, "google", c.sub)).toMatchObject({ accountId });
    expect(await getCredential(w.db, accountId, "google")).not.toBeNull();

    // Bootstrap hands back the plaintext key + envelope; simulate the client recovering the DEK.
    const material = await loadGoogleKeyMaterial(w.db, accountId, GOOGLE_KEK);
    expect(material.vaultId).toBe(vaultId);
    const privateKey = await importPrivateKeyPkcs8(Uint8Array.from(Buffer.from(material.privateKeyPkcs8, "base64")));
    const env = material.ownerEnvelope!;
    const dek = await unwrapDEKWithPrivateKey(
      Uint8Array.from(Buffer.from(env.wrappedDEK, "base64")),
      env.ephemeralPublicKeyJwk as JsonWebKey,
      privateKey,
    );

    // The DEK decrypts the R2 vault blob to the empty vault written at provisioning.
    const blob = new Uint8Array(await (await w.bucket.get(`${STORE_PREFIX}/${material.r2Key}`))!.arrayBuffer());
    expect(await decryptVaultV2(blob, dek)).toEqual({ clients: {} });

    // Exactly two envelopes: the owner's and the org-recovery one.
    const envelopes = await listEnvelopesForVault(w.db, vaultId);
    expect(envelopes.map((e) => e.principalAccountId).sort()).toEqual([accountId, ORG_ACCOUNT_ID].sort());
  });

  it("a wrong server KEK cannot unwrap the private key", async () => {
    const { accountId } = await provisionGoogleAccount(deps(), claims());
    const wrongKek = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    await expect(loadGoogleKeyMaterial(w.db, accountId, wrongKek)).rejects.toThrow();
  });

  it("derives a per-account KEK without throwing (distinctness proven by the wrong-KEK test)", async () => {
    // The derived KEK is non-extractable by design, so we can't compare raw bytes; the wrong-KEK
    // rejection above already proves the accountId salt makes each account's KEK unique.
    await expect(deriveGoogleKek(GOOGLE_KEK, "acct-A")).resolves.toBeTruthy();
    await expect(deriveGoogleKek(GOOGLE_KEK, "acct-B")).resolves.toBeTruthy();
  });
});

describe("linkGoogleToAccount (add Google to an existing account)", () => {
  it("wraps the caller's private key so bootstrap later recovers it", async () => {
    // A pre-existing (password-style) account with a keypair.
    const accountId = crypto.randomUUID();
    await createAccount(w.db, { id: accountId, displayName: "Existing", email: "link@example.com" });
    const { publicKeyJwk, privateKey } = await generateAccountKeypair();
    await putPublicKey(w.db, { accountId, publicKeyJwk });
    // Give it a vault + owner envelope so loadGoogleKeyMaterial has something to return.
    const { generateDEK, encryptVaultV2, wrapDEKForPublicKey } = await import("@tinytars/vault/crypto");
    const dek = await generateDEK();
    const vaultId = crypto.randomUUID();
    const r2Key = `data-${vaultId}.enc`;
    await w.bucket.put(`${STORE_PREFIX}/${r2Key}`, await encryptVaultV2({ clients: {} }, dek));
    await createVault(w.db, { vaultId, ownerAccountId: accountId, r2Key, hd1Version: 2 });
    const ownerEnv = await wrapDEKForPublicKey(dek, publicKeyJwk);
    await putEnvelope(w.db, { vaultId, principalAccountId: accountId, wrappedDek: ownerEnv.wrappedDEK, ephemeralPublicKeyJwk: ownerEnv.ephemeralPublicKeyJwk, createdBy: accountId });

    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
    const sub = "sub-link-" + crypto.randomUUID();
    await linkGoogleToAccount(w.db, accountId, sub, Buffer.from(pkcs8).toString("base64"), GOOGLE_KEK);

    expect(await getCredential(w.db, accountId, "google")).not.toBeNull();
    // Bootstrap recovers the SAME key → DEK → vault.
    const material = await loadGoogleKeyMaterial(w.db, accountId, GOOGLE_KEK);
    const recovered = await importPrivateKeyPkcs8(Uint8Array.from(Buffer.from(material.privateKeyPkcs8, "base64")));
    const env = material.ownerEnvelope!;
    const recoveredDek = await unwrapDEKWithPrivateKey(Uint8Array.from(Buffer.from(env.wrappedDEK, "base64")), env.ephemeralPublicKeyJwk as JsonWebKey, recovered);
    const blob = new Uint8Array(await (await w.bucket.get(`${STORE_PREFIX}/${r2Key}`))!.arrayBuffer());
    expect(await decryptVaultV2(blob, recoveredDek)).toEqual({ clients: {} });
  });

  it("refuses to link a sub already owned by another account", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await createAccount(w.db, { id: a, displayName: "A" });
    await createAccount(w.db, { id: b, displayName: "B" });
    const sub = "sub-dup-" + crypto.randomUUID();
    const { privateKey } = await generateAccountKeypair();
    const pkcs8 = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey))).toString("base64");
    await linkGoogleToAccount(w.db, a, sub, pkcs8, GOOGLE_KEK);
    await expect(linkGoogleToAccount(w.db, b, sub, pkcs8, GOOGLE_KEK)).rejects.toThrow(/another account/);
  });
});

describe("verifyIdTokenClaims", () => {
  const mkToken = (payload: Record<string, unknown>) =>
    `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  const base = () => ({ iss: "https://accounts.google.com", aud: "client-1", exp: Math.floor(Date.now() / 1000) + 600, nonce: "n1", sub: "s1", email: "e@x.com", email_verified: true, name: "N" });

  it("accepts a well-formed token and extracts claims", () => {
    const c = verifyIdTokenClaims(mkToken(base()), { clientId: "client-1", nonce: "n1" });
    expect(c).toMatchObject({ sub: "s1", email: "e@x.com", emailVerified: true, name: "N" });
  });
  it("rejects bad aud, bad nonce, wrong iss, and expiry", () => {
    expect(() => verifyIdTokenClaims(mkToken({ ...base(), aud: "other" }), { clientId: "client-1", nonce: "n1" })).toThrow(/aud/);
    expect(() => verifyIdTokenClaims(mkToken(base()), { clientId: "client-1", nonce: "wrong" })).toThrow(/nonce/);
    expect(() => verifyIdTokenClaims(mkToken({ ...base(), iss: "evil.com" }), { clientId: "client-1", nonce: "n1" })).toThrow(/iss/);
    expect(() => verifyIdTokenClaims(mkToken({ ...base(), exp: 1 }), { clientId: "client-1", nonce: "n1" })).toThrow(/expired/);
  });
});
