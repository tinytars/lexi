// W73 Phase D — provider-issued recovery, end to end against a real D1.
//
// Two patients and two clinicians throughout, because a test with one of each cannot tell a correct
// WHERE clause from a missing one — and here a missing one hands a stranger's health record away.
//
// The assertion that matters most is the last one in the happy path: the vault is DECRYPTED with the
// key the flow produced. Everything else could pass while the patient ends up signed in to a record
// they can no longer open, which is the failure this whole feature exists to prevent.

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database, LinkStatus, ProviderKind } from "../../functions/_lib/identity-types";
import { createAccount, sessionsValidFrom } from "../../functions/_lib/identity-accounts";
import { getCredential, putCredential, putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, getEnvelope, getEnvelopeRow, getVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { onRequestPost as issue } from "../../functions/api/recovery/grant";
import { onRequestPost as redeem } from "../../functions/api/auth/recovery/grant-redeem";
import { onRequestGet as grantSalt } from "../../functions/api/auth/recovery/grant-salt";
import { getLiveGrant, MAX_ATTEMPTS, GRANT_TTL_MS } from "../../functions/_lib/recovery";
import { signSession } from "../../functions/_lib/session";
import {
  generateAccountKeypair, generateDEK, wrapDEKForPublicKey, unwrapDEKWithPrivateKey,
  wrapDEKWithKek, unwrapDEKWithKek, deriveKekFromPassword, deriveAuthHash, wrapPrivateKey,
  unwrapPrivateKey, encryptVaultV2, decryptVaultV2,
} from "@tinytars/vault/crypto";

const SECRET = "test-secret";
const ITER = 200_000;
const CODE = "A7K29QMF3XPB";
let mf: Miniflare;
let db: any;

beforeEach(async () => {
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `test-grant-${crypto.randomUUID()}` },
  });
  db = await mf.getD1Database("DB");
  await applyMigrations(db as unknown as D1Database);
});
afterAll(async () => { await mf.dispose(); });

const env = () => ({ DB: db, SESSION_SECRET: SECRET }) as any;
const cookie = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function makePatient(email: string) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "P", email });
  await putPublicKey(db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(db, { vaultId, ownerAccountId: id, r2Key: `data-${id}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const e = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  await putEnvelope(db, { vaultId, principalAccountId: id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: id });
  // The real ciphertext, so a recovered key can be asked to open something.
  const blob = await encryptVaultV2({ clients: { alex: { note: "real record" } } } as never, dek);
  return { id, email, vaultId, dek, kp, blob };
}

async function makeClinician(kind: ProviderKind = "primary") {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "Doc", email: `${id}@clinic.test`, providerKind: kind });
  await putPublicKey(db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  return { id, kp };
}

async function link(patient: { id: string; vaultId: string; dek: CryptoKey }, doc: { id: string; kp: any }, over: Partial<{ status: LinkStatus; role: string; expiresAt: string }> = {}) {
  const e = await wrapDEKForPublicKey(patient.dek, doc.kp.publicKeyJwk);
  await putEnvelope(db, { vaultId: patient.vaultId, principalAccountId: doc.id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: patient.id });
  await createProviderLink(db, {
    ownerAccountId: patient.id, providerAccountId: doc.id,
    role: (over.role ?? "primary") as any, status: over.status ?? "active",
    grantedBy: patient.id, ...(over.expiresAt ? { expiresAt: over.expiresAt } : {}),
  });
}

/** What the clinician's browser does: wrap the DEK it already holds under PBKDF2 of a fresh code. */
async function grantBody(ownerAccountId: string, dek: CryptoKey, code = CODE) {
  const salt = rand(16);
  return {
    ownerAccountId,
    wrappedDek: b64(await wrapDEKWithKek(dek, await deriveKekFromPassword(code, salt))),
    kdfParams: { salt: hex(salt), iterations: ITER },
    codeAuthHash: await deriveAuthHash(code, salt),
  };
}

const postIssue = async (docId: string, body: unknown) =>
  issue({
    request: new Request("http://x/api/recovery/grant", { method: "POST", body: JSON.stringify(body), headers: { cookie: await cookie(docId) } }),
    env: env(),
  } as any);

const postRedeem = (body: unknown) =>
  redeem({
    request: new Request("http://x/api/auth/recovery/grant-redeem", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    env: env(),
  } as any);

describe("issuing", () => {
  it("lets a clinician with a live link issue a code", async () => {
    const p = await makePatient("p@example.com");
    const doc = await makeClinician();
    await link(p, doc);
    const res = await postIssue(doc.id, await grantBody(p.id, p.dek));
    expect(res.status).toBe(200);
    expect(await getLiveGrant(db, p.id)).toBeTruthy();
  });

  it("refuses a clinician who has no link with THIS patient", async () => {
    const mine = await makePatient("a@example.com");
    const theirs = await makePatient("b@example.com");
    const doc = await makeClinician();
    await link(mine, doc);
    const res = await postIssue(doc.id, await grantBody(theirs.id, theirs.dek));
    expect(res.status).toBe(403);
    expect(await getLiveGrant(db, theirs.id)).toBeNull();
  });

  it.each([
    ["revoked", { status: "revoked" as const }],
    ["expired", { expiresAt: new Date(Date.now() - 1000).toISOString() }],
    ["support-role", { role: "support" }],
  ])("refuses a %s link", async (_label, over) => {
    // A clinician's browser can still produce a valid wrapped DEK from a cached key long after the
    // grant lapsed, so the server re-checks rather than trusting that they could only have got here
    // legitimately.
    const p = await makePatient("p@example.com");
    const doc = await makeClinician();
    await link(p, doc, over as any);
    expect((await postIssue(doc.id, await grantBody(p.id, p.dek))).status).toBe(403);
  });

  it("refuses a SUPPORT agent even holding a CLINICIAN-role link", async () => {
    // Support can already open a granted vault through the audited path. Letting them mint account
    // control as well would make support a superuser — the capability table says clinician only.
    //
    // The link role is deliberately "clinician" here. With a support-role link the request is refused
    // by the live-link check instead, so the capability check would be untested — which is exactly what
    // mutation testing caught: flipping `recovery:issue` to include support changed nothing.
    const p = await makePatient("p@example.com");
    const agent = await makeClinician("support");
    await link(p, agent, { role: "primary" });
    const res = await postIssue(agent.id, await grantBody(p.id, p.dek));
    expect(res.status).toBe(403);
    expect((await res.json() as any).errorCode).toBe("not_permitted");
  });

  it("replaces a live grant rather than stacking a second one", async () => {
    const p = await makePatient("p@example.com");
    const doc = await makeClinician();
    await link(p, doc);
    await postIssue(doc.id, await grantBody(p.id, p.dek));
    const first = await getLiveGrant(db, p.id);
    await postIssue(doc.id, await grantBody(p.id, p.dek, "SECONDCODE22"));
    const second = await getLiveGrant(db, p.id);
    expect(second!.id).not.toBe(first!.id);
    const rows = await db.prepare("SELECT id, wrapped_dek FROM recovery_grants WHERE account_id = ? AND consumed_at IS NULL").bind(p.id).all();
    expect(rows.results).toHaveLength(1);
    // …and the superseded blob is destroyed, not merely marked. A blob left behind is an offline target.
    const old = await db.prepare("SELECT wrapped_dek FROM recovery_grants WHERE id = ?").bind(first!.id).first();
    expect(old.wrapped_dek).toBeNull();
  });

  it("records who issued it, against the patient", async () => {
    const p = await makePatient("p@example.com");
    const doc = await makeClinician();
    await link(p, doc);
    await postIssue(doc.id, await grantBody(p.id, p.dek));
    const events = await listAccessEventsForSubject(db, p.id);
    expect(events.map((e) => e.action)).toContain("recovery.grant_issued");
    expect(events[0].actorAccountId).toBe(doc.id);
  });

  it("refuses emailed delivery, because the server would have to hold the code", async () => {
    const p = await makePatient("p@example.com");
    const doc = await makeClinician();
    await link(p, doc);
    const res = await postIssue(doc.id, { ...(await grantBody(p.id, p.dek)), delivery: "email" });
    // Ignored, not honoured: `delivery` is not a parameter. Asserting the grant is still created as a
    // spoken one documents that a client cannot opt into a mode that does not exist.
    expect(res.status).toBe(200);
    expect(await getLiveGrant(db, p.id)).toBeTruthy();
  });
});

describe("redeeming", () => {
  async function issued() {
    const p = await makePatient("p@example.com");
    const doc = await makeClinician();
    await link(p, doc);
    await postIssue(doc.id, await grantBody(p.id, p.dek));
    return { p, doc };
  }

  it("gets the patient back into their own record", async () => {
    const { p } = await issued();
    const salt = Uint8Array.from(Buffer.from((await getLiveGrant(db, p.id))!.kdfParams.salt, "hex"));

    // Call 1 — fetch the wrapped DEK and open it with the spoken code.
    const first = await postRedeem({ email: p.email, codeAuthHash: await deriveAuthHash(CODE, salt) });
    expect(first.status).toBe(200);
    const { wrappedDek } = (await first.json()) as any;
    const dek = await unwrapDEKWithKek(Uint8Array.from(Buffer.from(wrappedDek, "base64")), await deriveKekFromPassword(CODE, salt));

    // Call 2 — a NEW keypair, the private half locked under a new password, the DEK wrapped to it.
    const fresh = await generateAccountKeypair();
    const pwSalt = rand(16);
    const env2 = await wrapDEKForPublicKey(dek, fresh.publicKeyJwk);
    const second = await postRedeem({
      email: p.email,
      codeAuthHash: await deriveAuthHash(CODE, salt),
      newIdentity: {
        publicKeyJwk: fresh.publicKeyJwk,
        wrappedPrivateKey: b64(await wrapPrivateKey(fresh.privateKey, await deriveKekFromPassword("brand-new", pwSalt))),
        kdfParams: { salt: hex(pwSalt), iterations: ITER },
        authHash: await deriveAuthHash("brand-new", pwSalt),
        envelope: { wrappedDEK: b64(env2.wrappedDEK), ephemeralPublicKeyJwk: env2.ephemeralPublicKeyJwk },
      },
    });
    expect(second.status).toBe(200);

    // THE ASSERTION THAT MATTERS: sign in as the patient would, and open the actual record.
    const cred = await getCredential(db, p.id, "password");
    const priv = await unwrapPrivateKey(cred!.wrappedPrivateKey, await deriveKekFromPassword("brand-new", pwSalt));
    const stored = await getEnvelope(db, p.vaultId, p.id);
    const recoveredDek = await unwrapDEKWithPrivateKey(stored!.wrappedDek, stored!.ephemeralPublicKeyJwk as JsonWebKey, priv);
    expect(await decryptVaultV2(p.blob, recoveredDek)).toEqual({ clients: { alex: { note: "real record" } } });
  });

  it("clears the other credentials, which wrap a key nothing references any more", async () => {
    const { p } = await issued();
    await putCredential(db, { accountId: p.id, method: "passkey", wrappedPrivateKey: rand(48), kdfParams: { credentialID: "c1" } });
    await putCredential(db, { accountId: p.id, method: "recovery", wrappedPrivateKey: rand(48), kdfParams: { salt: hex(rand(16)), iterations: ITER, authHashSha256: "x" } });
    await completeRecovery(p);
    expect(await getCredential(db, p.id, "passkey")).toBeNull();
    // The stale recovery credential is the dangerous one: auth/recovery/login.ts mints a session on an
    // authHash compare BEFORE any key is used, so leaving it would hand out sessions for an account it
    // can no longer open.
    expect(await getCredential(db, p.id, "recovery")).toBeNull();
  });

  it("leaves the provider and org envelopes alone — the DEK did not change", async () => {
    const { p, doc } = await issued();
    await completeRecovery(p);
    expect(await getEnvelopeRow(db, p.vaultId, doc.id)).not.toBeNull();
  });

  it("revokes sessions and flags the vault for re-keying", async () => {
    const { p } = await issued();
    await completeRecovery(p);
    expect(await sessionsValidFrom(db, p.id)).toBeTruthy();
    expect((await getVault(db, p.vaultId))!.rotationPending).toBe(true);
  });

  it("cannot be replayed once consumed", async () => {
    const { p } = await issued();
    const salt = Uint8Array.from(Buffer.from((await getLiveGrant(db, p.id))!.kdfParams.salt, "hex"));
    await completeRecovery(p);
    const again = await postRedeem({ email: p.email, codeAuthHash: await deriveAuthHash(CODE, salt) });
    expect(again.status).toBe(401);
    expect(await getLiveGrant(db, p.id)).toBeNull();
  });

  // W75 — the cap used to be read, compared and incremented in three separate statements against a
  // counter that is the only thing between a twelve-character code and the DEK it wraps. Concurrent
  // redemptions all read the same count, all passed the comparison, and all incremented, so
  // MAX_ATTEMPTS meant that many ROUNDS of unbounded width. Fired in parallel because a sequential
  // loop cannot observe the race the fix exists to close.
  it("counts every concurrent wrong guess, so the cap is attempts and not rounds", async () => {
    const { p } = await issued();
    const g = await getLiveGrant(db, p.id);
    const salt = Uint8Array.from(Buffer.from(g!.kdfParams.salt, "hex"));
    const wrong = await deriveAuthHash("WRONGWRONGWR", salt);

    const results = await Promise.all(Array.from({ length: 12 }, () => postRedeem({ email: p.email, codeAuthHash: wrong })));
    expect(results.every((r) => r.status === 401)).toBe(true);

    // Every attempt landed on the row, and the grant is destroyed rather than sitting spent.
    const row = await db.prepare("SELECT attempts, consumed_at, wrapped_dek FROM recovery_grants WHERE id = ?").bind(g!.id).first();
    expect(row.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
    expect(row.consumed_at).not.toBeNull();
    expect(row.wrapped_dek).toBeNull();

    // And the RIGHT code no longer works — the burst spent the grant, not one round of it.
    expect((await postRedeem({ email: p.email, codeAuthHash: await deriveAuthHash(CODE, salt) })).status).toBe(401);
  });

  it("refuses the RIGHT code once the attempt cap is already reached", async () => {
    // Targets the cap guard directly. The wrong-code path also burns the grant on its final attempt, so
    // a test that only walks the attempts up cannot tell the two mechanisms apart — removing the cap
    // left that test green. This one drives `attempts` straight to the limit, which is also the state a
    // pair of concurrent requests can produce.
    const { p } = await issued();
    const g = await getLiveGrant(db, p.id);
    const salt = Uint8Array.from(Buffer.from(g!.kdfParams.salt, "hex"));
    await db.prepare("UPDATE recovery_grants SET attempts = ? WHERE id = ?").bind(MAX_ATTEMPTS, g!.id).run();
    expect((await postRedeem({ email: p.email, codeAuthHash: await deriveAuthHash(CODE, salt) })).status).toBe(401);
    expect(await getLiveGrant(db, p.id)).toBeNull();
  });

  it("burns the grant after too many wrong codes", async () => {
    const { p } = await issued();
    const salt = Uint8Array.from(Buffer.from((await getLiveGrant(db, p.id))!.kdfParams.salt, "hex"));
    const wrong = await deriveAuthHash("WRONGWRONG12", salt);
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await postRedeem({ email: p.email, codeAuthHash: wrong })).status).toBe(401);
    // The RIGHT code no longer works, and the blob is gone.
    expect((await postRedeem({ email: p.email, codeAuthHash: await deriveAuthHash(CODE, salt) })).status).toBe(401);
    expect(await getLiveGrant(db, p.id)).toBeNull();
  });

  it("refuses an expired grant and destroys its blob", async () => {
    const { p } = await issued();
    const g = await getLiveGrant(db, p.id);
    const salt = Uint8Array.from(Buffer.from(g!.kdfParams.salt, "hex"));
    await db.prepare("UPDATE recovery_grants SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - GRANT_TTL_MS).toISOString(), g!.id).run();
    expect((await postRedeem({ email: p.email, codeAuthHash: await deriveAuthHash(CODE, salt) })).status).toBe(401);
    const row = await db.prepare("SELECT wrapped_dek FROM recovery_grants WHERE id = ?").bind(g!.id).first();
    expect(row.wrapped_dek).toBeNull();
  });

  it("says the same thing for an unknown address as for a wrong code", async () => {
    // Otherwise this route reports whether a clinician has issued a recovery for a given person, which
    // is a fact about their care and not merely about their account.
    const { p } = await issued();
    const salt = Uint8Array.from(Buffer.from((await getLiveGrant(db, p.id))!.kdfParams.salt, "hex"));
    const unknown = await postRedeem({ email: "nobody@example.com", codeAuthHash: await deriveAuthHash(CODE, salt) });
    const wrongCode = await postRedeem({ email: p.email, codeAuthHash: await deriveAuthHash("NOPENOPE1234", salt) });
    expect(unknown.status).toBe(wrongCode.status);
    expect(await unknown.json()).toEqual(await wrongCode.json());
  });

  it("does not burn the code on a malformed second call", async () => {
    const { p } = await issued();
    const salt = Uint8Array.from(Buffer.from((await getLiveGrant(db, p.id))!.kdfParams.salt, "hex"));
    const hash = await deriveAuthHash(CODE, salt);
    expect((await postRedeem({ email: p.email, codeAuthHash: hash, newIdentity: { publicKeyJwk: {} } })).status).toBe(400);
    expect(await getLiveGrant(db, p.id)).toBeTruthy();
  });

  it("cannot be redeemed with one patient's code against another's account", async () => {
    const { p } = await issued();
    const other = await makePatient("other@example.com");
    const salt = Uint8Array.from(Buffer.from((await getLiveGrant(db, p.id))!.kdfParams.salt, "hex"));
    expect((await postRedeem({ email: other.email, codeAuthHash: await deriveAuthHash(CODE, salt) })).status).toBe(401);
  });

  /** Runs both redemption calls with a fresh keypair. Returns the new password's salt. */
  async function completeRecovery(p: Awaited<ReturnType<typeof makePatient>>) {
    const salt = Uint8Array.from(Buffer.from((await getLiveGrant(db, p.id))!.kdfParams.salt, "hex"));
    const hash = await deriveAuthHash(CODE, salt);
    const first = await postRedeem({ email: p.email, codeAuthHash: hash });
    const { wrappedDek } = (await first.json()) as any;
    const dek = await unwrapDEKWithKek(Uint8Array.from(Buffer.from(wrappedDek, "base64")), await deriveKekFromPassword(CODE, salt));
    const fresh = await generateAccountKeypair();
    const pwSalt = rand(16);
    const e = await wrapDEKForPublicKey(dek, fresh.publicKeyJwk);
    const res = await postRedeem({
      email: p.email, codeAuthHash: hash,
      newIdentity: {
        publicKeyJwk: fresh.publicKeyJwk,
        wrappedPrivateKey: b64(await wrapPrivateKey(fresh.privateKey, await deriveKekFromPassword("brand-new", pwSalt))),
        kdfParams: { salt: hex(pwSalt), iterations: ITER },
        authHash: await deriveAuthHash("brand-new", pwSalt),
        envelope: { wrappedDEK: b64(e.wrappedDEK), ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk },
      },
    });
    expect(res.status).toBe(200);
    return pwSalt;
  }
});

describe("the grant-salt lookup does not reveal whether a recovery is under way", () => {
  const salt = async (email: string) =>
    (await (await grantSalt({ request: new Request(`http://x/api/auth/recovery/grant-salt?email=${encodeURIComponent(email)}`), env: env() } as any)).json()) as any;

  it("answers a real grant and an unknown address indistinguishably", async () => {
    const p = await makePatient("p@example.com");
    const doc = await makeClinician();
    await link(p, doc);
    await postIssue(doc.id, await grantBody(p.id, p.dek));

    const real = await salt("p@example.com");
    const decoy = await salt("nobody@example.com");
    // Whether a clinician has started a recovery for someone is a fact about their CARE, not just
    // their account, so the shapes have to be identical.
    expect(Object.keys(real).sort()).toEqual(Object.keys(decoy).sort());
    expect(decoy.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(real.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a decoy for a real account with no live grant", async () => {
    await makePatient("quiet@example.com");
    expect((await salt("quiet@example.com")).salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is stable per address, so a decoy is not recognisable by changing", async () => {
    expect((await salt("nobody@example.com")).salt).toBe((await salt("nobody@example.com")).salt);
  });

  it("differs per address, so it is not recognisable by being constant", async () => {
    expect((await salt("a@example.com")).salt).not.toBe((await salt("b@example.com")).salt);
  });

  it("uses a different decoy domain from the recovery-credential salt", async () => {
    // Otherwise the two lookups could be compared against each other to learn which KIND of recovery
    // an address has, which is the oracle both decoys exist to close.
    const { decoySalt } = await import("../../functions/_lib/decoy-salt");
    const asGrant = await decoySalt(SECRET, "x@example.com", "grant");
    const asRecovery = await decoySalt(SECRET, "x@example.com", "recovery");
    expect(asGrant).not.toBe(asRecovery);
    expect((await salt("x@example.com")).salt).toBe(asGrant);
  });
});

describe("wrapDEKWithKek", () => {
  it("round-trips a DEK that still decrypts the vault", async () => {
    const dek = await generateDEK();
    const blob = await encryptVaultV2({ clients: {} } as never, dek);
    const kek = await deriveKekFromPassword(CODE, rand(16));
    const back = await unwrapDEKWithKek(await wrapDEKWithKek(dek, kek), kek);
    expect(await decryptVaultV2(blob, back)).toEqual({ clients: {} });
  });

  it("refuses the wrong code rather than returning a wrong key", async () => {
    const salt = rand(16);
    const wrapped = await wrapDEKWithKek(await generateDEK(), await deriveKekFromPassword(CODE, salt));
    await expect(unwrapDEKWithKek(wrapped, await deriveKekFromPassword("WRONG", salt))).rejects.toThrow(/wrong recovery code/);
  });
});
