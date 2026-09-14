// W72 items 17+18 — account erasure, end to end, against a real D1 and a real R2.
//
// This is the most destructive operation the application has, so the tests are shaped around the two
// ways it can be wrong: it can delete too little (the subject is told their data is gone when it is
// not) and it can delete too much (it reaches another account's data). Both are checked with a SECOND
// account seeded alongside the first, because an erasure test with one account in the database cannot
// tell a correct WHERE clause from a missing one.

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount, getAccount, sessionsValidFrom } from "../../functions/_lib/identity-accounts";
import { getPublicKey, listCredentials, putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, listEnvelopesForPrincipal, listEnvelopesForVault, listVaultsForOwner, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink, listProvidersForPatient } from "../../functions/_lib/identity-providers";
import { insertAccessEvent, listAccessEventsForSubject, listRawObjectsForAccount, recordRawObject } from "../../functions/_lib/identity-audit";
import { eraseAccount, chatKeyForVault, r2KeysForAccount } from "../../functions/_lib/erasure";
import { onRequestPost as erase } from "../../functions/api/account/erase";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

const SECRET = "test-secret";
const STORE = "dev";
let mf: Miniflare;
let db: any;
let bucket: any;

async function fresh() {
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `test-erase-${crypto.randomUUID()}` },
    r2Buckets: { VAULT: `vault-${crypto.randomUUID()}` },
  });
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("VAULT");
  await applyMigrations(db as unknown as D1Database);
}

beforeEach(fresh);
afterAll(async () => { await mf.dispose(); });

const env = () => ({ DB: db, VAULT: bucket, SESSION_SECRET: SECRET, STORE_PREFIX: STORE }) as any;
const cookie = async (id: string) => `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}`;

async function seedPatient(email: string, clientKey: string) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "P", email });
  await putPublicKey(db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  const slug = id;
  await createVault(db, { vaultId, ownerAccountId: id, r2Key: `data-${slug}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const e = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  await putEnvelope(db, { vaultId, principalAccountId: id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: id });

  await bucket.put(`${STORE}/data-${slug}.enc`, "vault-ciphertext");
  await bucket.put(`${STORE}/chat-${slug}.enc`, "chat-ciphertext");
  const rawKey = `${STORE}/raw/${clientKey}/report.pdf`;
  const textKey = `${STORE}/text/${clientKey}/report.pdf.json`;
  await bucket.put(rawKey, "PDF BYTES");
  await bucket.put(textKey, '{"text":"plaintext phi"}');
  await recordRawObject(db, rawKey, id);
  await recordRawObject(db, textKey, id);
  return { id, vaultId, slug, rawKey, textKey, email };
}

const listKeys = async () => (await bucket.list()).objects.map((o: any) => o.key).sort();

describe("eraseAccount", () => {
  it("deletes the vault blob, the chat history, the originals and the extracted text", async () => {
    const p = await seedPatient("a@example.com", "alex");
    const report = await eraseAccount(env(), p.id);
    expect(await listKeys()).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.r2Deleted).toContain(`${STORE}/data-${p.slug}.enc`);
    expect(report.r2Deleted).toContain(`${STORE}/chat-${p.slug}.enc`);
    expect(report.r2Deleted).toContain(p.rawKey);
    expect(report.r2Deleted).toContain(p.textKey);
  });

  it("does not touch another account's objects or rows", async () => {
    const mine = await seedPatient("a@example.com", "alex");
    const theirs = await seedPatient("b@example.com", "blair");
    await eraseAccount(env(), mine.id);
    expect(await listKeys()).toEqual([theirs.rawKey, theirs.textKey, `${STORE}/chat-${theirs.slug}.enc`, `${STORE}/data-${theirs.slug}.enc`].sort());
    expect(await getAccount(db, theirs.id)).toMatchObject({ email: "b@example.com", deletedAt: null });
    expect(await listVaultsForOwner(db, theirs.id)).toHaveLength(1);
    expect(await listRawObjectsForAccount(db, theirs.id)).toHaveLength(2);
  });

  it("tombstones the account rather than deleting the row, and nulls every personal field", async () => {
    const p = await seedPatient("a@example.com", "alex");
    await eraseAccount(env(), p.id);
    const acct = await getAccount(db, p.id);
    expect(acct).not.toBeNull();
    expect(acct!.email).toBeNull();
    expect(acct!.displayName).toBe("");
    expect(acct!.providerKind).toBeNull();
    expect(acct!.deletedAt).toBeTruthy();
    // The id survives on purpose — phi_access_events points at it. See the migration.
    expect(acct!.id).toBe(p.id);
  });

  it("revokes outstanding sessions before the account becomes a tombstone", async () => {
    const p = await seedPatient("a@example.com", "alex");
    await eraseAccount(env(), p.id);
    expect(await sessionsValidFrom(db, p.id)).toBeTruthy();
  });

  it("removes the key-wrapping envelopes, the vault rows and the credentials", async () => {
    const p = await seedPatient("a@example.com", "alex");
    await eraseAccount(env(), p.id);
    expect(await listVaultsForOwner(db, p.id)).toEqual([]);
    expect(await listEnvelopesForVault(db, p.vaultId)).toEqual([]);
    expect(await listCredentials(db, p.id)).toEqual([]);
    expect(await getPublicKey(db, p.id)).toBeNull();
    expect(await listRawObjectsForAccount(db, p.id)).toEqual([]);
  });

  it("revokes grants in BOTH directions, so no live link points at a dead account", async () => {
    const patient = await seedPatient("a@example.com", "alex");
    const provId = crypto.randomUUID();
    await createAccount(db, { id: provId, displayName: "Doc", email: "doc@example.com", providerKind: "primary" });
    await createProviderLink(db, { ownerAccountId: patient.id, providerAccountId: provId, role: "primary", status: "active", grantedBy: patient.id });
    // The PROVIDER erases itself: the patient must not be left holding an active grant to nobody.
    await eraseAccount(env(), provId);
    expect(await listProvidersForPatient(db, patient.id)).toEqual([]);
  });

  it("deletes an envelope this account held on someone else's vault", async () => {
    const patient = await seedPatient("a@example.com", "alex");
    const prov = await generateAccountKeypair();
    const provId = crypto.randomUUID();
    await createAccount(db, { id: provId, displayName: "Doc", email: "doc@example.com", providerKind: "primary" });
    const e = await wrapDEKForPublicKey(await generateDEK(), prov.publicKeyJwk);
    await putEnvelope(db, { vaultId: patient.vaultId, principalAccountId: provId, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: patient.id });
    await eraseAccount(env(), provId);
    expect(await listEnvelopesForPrincipal(db, provId)).toEqual([]);
    // …and the patient's own envelope is untouched.
    expect(await listEnvelopesForVault(db, patient.vaultId)).toHaveLength(1);
  });

  it("destroys a live recovery grant, which holds a key to the record it just erased", async () => {
    const p = await seedPatient("a@example.com", "alex");
    await db.prepare(
      "INSERT INTO recovery_grants (id, account_id, wrapped_dek, kdf_params, code_verifier_sha256, issued_by, issued_at, expires_at, attempts, consumed_at) VALUES (?, ?, ?, '{}', 'v', ?, ?, ?, 0, NULL)",
    ).bind(crypto.randomUUID(), p.id, new Uint8Array([1, 2, 3]), p.id, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()).run();

    await eraseAccount(env(), p.id);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM recovery_grants WHERE account_id = ?").bind(p.id).first();
    expect(left.n).toBe(0);
  });

  it("keeps the access-event trail, which names other people's records too", async () => {
    const patient = await seedPatient("a@example.com", "alex");
    const provId = crypto.randomUUID();
    await createAccount(db, { id: provId, displayName: "Doc", email: "doc@example.com", providerKind: "primary" });
    await insertAccessEvent(db, { actorAccountId: provId, subjectAccountId: patient.id, action: "vault.read" });
    await eraseAccount(env(), patient.id);
    // Erasing the subject must not erase the evidence that a DIFFERENT principal read something.
    expect(await listAccessEventsForSubject(db, patient.id)).toHaveLength(1);
  });

  it("is safe to run twice", async () => {
    const p = await seedPatient("a@example.com", "alex");
    await eraseAccount(env(), p.id);
    const second = await eraseAccount(env(), p.id);
    expect(second.r2Deleted).toEqual([]);
    expect(second.complete).toBe(true);
  });

  it("reports pre-0008 objects in this patient's own namespace as unattributable", async () => {
    const p = await seedPatient("a@example.com", "alex");
    // An original written before the ownership table existed: present in R2, absent from raw_objects,
    // and under THIS patient's namespace, which is what makes it this erasure's problem.
    const orphan = `${STORE}/raw/alex/old.pdf`;
    await bucket.put(orphan, "PDF BYTES");
    const report = await eraseAccount(env(), p.id);
    expect(report.unattributable).toBe(1);
    expect(report.complete).toBe(false);
    // Left in place: the server cannot prove whose it is, and deleting it could destroy another
    // patient's only copy. Reported so nobody is told the erasure was complete.
    expect(await bucket.get(orphan)).not.toBeNull();
  });

  it("does not count a pre-0008 orphan in someone else's namespace against this erasure", async () => {
    // W75. The count used to be store-wide, so an unowned object that this erasure was never going to
    // touch made the report say incomplete — a false alarm that trains the reader to ignore the field
    // that matters.
    const p = await seedPatient("a@example.com", "alex");
    await bucket.put(`${STORE}/raw/someone-else/old.pdf`, "PDF BYTES");
    const report = await eraseAccount(env(), p.id);
    expect(report.unattributable).toBe(0);
    expect(report.complete).toBe(true);
  });

  it("reports incomplete when a clinician owns an object in the erased patient's namespace", async () => {
    // W75, the severe half. Ownership is first-writer-wins, so a PDF a clinician uploaded ABOUT this
    // patient carries the CLINICIAN's owner row: it is not selected for deletion (not ours) and, under
    // the old store-wide "has no owner row" count, was not counted either. The subject was told
    // complete: true while their PHI sat in the bucket.
    const p = await seedPatient("a@example.com", "alex");
    const clinician = await seedPatient("doc@example.com", "clinic");
    const theirs = `${STORE}/raw/alex/clinician-upload.pdf`;
    await bucket.put(theirs, "PDF BYTES");
    await recordRawObject(db, theirs, clinician.id);

    const report = await eraseAccount(env(), p.id);
    expect(report.complete).toBe(false);
    expect(report.unattributable).toBe(1);
    expect(report.r2Deleted).not.toContain(theirs);
    expect(await bucket.get(theirs)).not.toBeNull();
  });
});

describe("the unattributable count follows R2's cursor", () => {
  it("does not stop at the first page", async () => {
    // W73 correction. R2 caps a page at 1000 and health-vault already holds 1259, so a single list()
    // silently stopped counting — and because this count decides `complete`, an erasure that HAD left
    // objects behind could report complete: true. The same cap cost this project five nights of silent
    // backup failures; this is the second time it has bitten.
    const p = await seedPatient("a@example.com", "alex");
    const real = bucket;
    let pages = 0;
    // A bucket that pages at 2 objects, so the loop is exercised without writing 1001 of them.
    const paging = {
      delete: (k: string) => real.delete(k),
      async list(opts: { prefix: string; cursor?: string }) {
        const all = (await real.list({ prefix: opts.prefix })).objects;
        const start = opts.cursor ? Number(opts.cursor) : 0;
        pages++;
        const slice = all.slice(start, start + 2);
        const next = start + 2;
        return { objects: slice, truncated: next < all.length, cursor: String(next) };
      },
    };
    for (let i = 0; i < 5; i++) await bucket.put(`${STORE}/raw/alex/${i}.pdf`, "PDF");

    const report = await eraseAccount({ ...env(), VAULT: paging } as any, p.id);
    expect(pages).toBeGreaterThan(2);
    expect(report.unattributable).toBe(5);
    expect(report.complete).toBe(false);
  });
});

describe("chatKeyForVault", () => {
  it("derives the chat blob from the vault's own r2Key", () => {
    expect(chatKeyForVault({ STORE_PREFIX: "dev" }, { r2Key: "data-abc.enc" } as any)).toBe("dev/chat-abc.enc");
  });

  it("returns null rather than guessing when the r2Key is not the expected shape", () => {
    // A silent fallback here would build a wrong key and "successfully" delete nothing.
    expect(chatKeyForVault({ STORE_PREFIX: "dev" }, { r2Key: "legacy.bin" } as any)).toBeNull();
  });
});

describe("POST /api/account/erase", () => {
  const post = (body: unknown, cookieHeader?: string) =>
    erase({
      request: new Request("https://x/api/account/erase", {
        method: "POST",
        body: JSON.stringify(body),
        headers: cookieHeader ? { cookie: cookieHeader } : {},
      }),
      env: env(),
    } as any);

  it("refuses without a session", async () => {
    expect((await post({ confirmEmail: "a@example.com" })).status).toBe(401);
  });

  it("refuses when the confirmation does not match the account email", async () => {
    const p = await seedPatient("a@example.com", "alex");
    const res = await post({ confirmEmail: "b@example.com" }, await cookie(p.id));
    expect(res.status).toBe(400);
    expect((await res.json() as any).errorCode).toBe("confirmation_mismatch");
    // Nothing was deleted on a failed confirmation.
    expect(await listKeys()).toHaveLength(4);
  });

  it("refuses an empty confirmation on an account that has no email", async () => {
    const id = crypto.randomUUID();
    await createAccount(db, { id, displayName: "NoEmail" });
    const res = await post({ confirmEmail: "" }, await cookie(id));
    expect(res.status).toBe(400);
  });

  it("accepts the confirmation case- and whitespace-insensitively and erases", async () => {
    const p = await seedPatient("a@example.com", "alex");
    const res = await post({ confirmEmail: "  A@Example.com " }, await cookie(p.id));
    expect(res.status).toBe(200);
    expect(await listKeys()).toEqual([]);
    expect((await res.json() as any).complete).toBe(true);
  });

  it("tells the caller when the erasure was incomplete rather than reporting success", async () => {
    const p = await seedPatient("a@example.com", "alex");
    await bucket.put(`${STORE}/raw/alex/old.pdf`, "PDF");
    const res = await post({ confirmEmail: p.email }, await cookie(p.id));
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.complete).toBe(false);
    expect(body.unattributable).toBe(1);
  });

  it("erases only the caller, with no way to name another account", async () => {
    const mine = await seedPatient("a@example.com", "alex");
    const theirs = await seedPatient("b@example.com", "blair");
    // There is no accountId parameter; supplying one must be inert, not authoritative.
    const res = await post({ confirmEmail: mine.email, accountId: theirs.id }, await cookie(mine.id));
    expect(await getAccount(db, theirs.id)).toMatchObject({ deletedAt: null });
    // And a second patient's correctly-owned objects must not make MY erasure read incomplete —
    // "unattributable" means nobody owns it, not "somebody else owns it". This assertion is the one
    // that caught the first implementation counting every other account's originals.
    expect((await res.json() as any).complete).toBe(true);
  });
});

describe("r2KeysForAccount", () => {
  it("returns nothing for an account with no vault, rather than a store-wide prefix", async () => {
    const id = crypto.randomUUID();
    await createAccount(db, { id, displayName: "Empty" });
    expect((await r2KeysForAccount(env(), id)).keys).toEqual([]);
  });
});
