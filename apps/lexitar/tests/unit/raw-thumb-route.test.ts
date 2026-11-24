// The `?thumb=1` arm of /api/raw, against a real D1 and R2 for the reason raw-authorization.test.ts
// gives in its own first line: a fake can be made to agree with whatever the route does, and what
// these cases are about is which KEY the route touches and whether a non-owner may write one.
//
// The thumbnail is a chip-sized copy of an attachment, `thumb/{slug}/{file}`, sealed under the
// original's own content key. Four properties are worth a test and they are not the same property:
// a thumbnail read is a disclosure and carries every gate a full read carries; a thumbnail WRITE is
// narrower than an upload, because it is a derivative somebody minted from a read rather than
// content they were offered; a delete takes both copies with no flag to ask for it; and a missing
// thumbnail is a 404 the client is built to expect rather than an error.
import { describe, it, expect } from "vitest";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { recordRawObject } from "../../functions/_lib/identity-audit";
import { onRequestGet as rawGet, onRequestPut as rawPut, onRequestDelete as rawDelete } from "../../functions/api/raw/[[path]]";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { sealedRawBlob } from "../support/blobs";

const STORE = "dev";
const FILE = "ab12cd34-photo.jpg";
// Fixtures reuse one client name, so each test needs its own namespace table.
const w = useWorkerd({ r2: true, perTest: true });

const env = () => ({ DB: w.db, VAULT: w.bucket, SESSION_SECRET, STORE_PREFIX: STORE }) as any;
const cookie = async (id: string) => ({ cookie: await cookieFor(id) });

const rawKey = (slug: string, file = FILE) => `${STORE}/raw/${slug}/${file}`;
const thumbKey = (slug: string, file = FILE) => `${STORE}/thumb/${slug}/${file}`;

/** A patient owning `slug`, with one stored original and no thumbnail — every account's state today. */
async function patient(slug: string) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: slug, email: `${slug}@example.com` });
  await putPublicKey(w.db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: id, r2Key: `data-${id}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const e = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: id });
  await w.bucket.put(rawKey(slug), sealedRawBlob(64));
  await recordRawObject(w.db, rawKey(slug), id);
  return { id, slug, vaultId, dek };
}

async function clinicianFor(p: Awaited<ReturnType<typeof patient>>) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "Doc", email: `${id}@clinic.test`, providerKind: "primary" });
  await putPublicKey(w.db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const e = await wrapDEKForPublicKey(p.dek, kp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId: p.vaultId, principalAccountId: id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: p.id });
  await createProviderLink(w.db, { ownerAccountId: p.id, providerAccountId: id, role: "primary", status: "active", grantedBy: p.id });
  return { id };
}

const get = async (who: string, slug: string, q = "") =>
  rawGet({ request: new Request(`http://x/api/raw/${slug}/${FILE}${q}`, { headers: await cookie(who) }), env: env(), params: { path: [slug, FILE] } } as any);
const put = async (who: string, slug: string, q = "", body: BodyInit = sealedRawBlob(48)) =>
  rawPut({ request: new Request(`http://x/api/raw/${slug}/${FILE}${q}`, { method: "PUT", headers: await cookie(who), body }), env: env(), params: { path: [slug, FILE] } } as any);
const del = async (who: string, slug: string) =>
  rawDelete({ request: new Request(`http://x/api/raw/${slug}/${FILE}`, { method: "DELETE", headers: await cookie(who) }), env: env(), params: { path: [slug, FILE] } } as any);

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());
const rows = async (key: string) =>
  (await w.db.prepare("SELECT account_id FROM raw_objects WHERE r2_key = ?").bind(key).first<{ account_id: string }>())?.account_id ?? null;

describe("GET with ?thumb=1", () => {
  it("404s while the original is present, which is the signal the chip falls back on", async () => {
    const p = await patient("alex");
    expect((await get(p.id, p.slug)).status).toBe(200);
    const res = await get(p.id, p.slug, "?thumb=1");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("raw thumbnail not found");
  });

  it("reads the thumb key and not the raw one, so the small copy is what the chip gets", async () => {
    const p = await patient("alex");
    const small = sealedRawBlob(36);
    await w.bucket.put(thumbKey(p.slug), small);
    const res = await get(p.id, p.slug, "?thumb=1");
    expect(res.status).toBe(200);
    expect(await bytesOf(res)).toEqual(small);
    // And the unflagged read is untouched: both artefacts exist and each handler asks for its own.
    expect(await bytesOf(await get(p.id, p.slug))).toEqual(sealedRawBlob(64));
  });

  it("a stranger is refused, the flag buying no way past the ownership gate", async () => {
    const p = await patient("alex");
    await w.bucket.put(thumbKey(p.slug), sealedRawBlob(36));
    const s = crypto.randomUUID();
    await createAccount(w.db, { id: s, displayName: "S", email: `${s}@example.com` });
    expect((await get(s, p.slug, "?thumb=1")).status).toBe(404); // 404 and not 403, as every raw read is
  });
});

describe("PUT with ?thumb=1", () => {
  it("writes the thumb key, leaves the original alone, and records the row", async () => {
    const p = await patient("alex");
    const small = sealedRawBlob(48);
    expect((await put(p.id, p.slug, "?thumb=1", small)).status).toBe(204);
    expect(new Uint8Array(await (await w.bucket.get(thumbKey(p.slug)))!.arrayBuffer())).toEqual(small);
    expect(new Uint8Array(await (await w.bucket.get(rawKey(p.slug)))!.arrayBuffer())).toEqual(sealedRawBlob(64));
    // The row is what makes the thumbnail ERASABLE: erasure deletes by key from these rows, so a
    // thumbnail written without one is a legible picture an account erasure would walk straight past.
    expect(await rows(thumbKey(p.slug))).toBe(p.id);
  });

  it("refuses plaintext, inheriting the chokepoint above it rather than restating it", async () => {
    const p = await patient("alex");
    const res = await put(p.id, p.slug, "?thumb=1", new Uint8Array(64));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe("plaintext_refused");
    expect(await w.bucket.get(thumbKey(p.slug))).toBeNull();
  });

  // The asymmetry that is the whole point of the arm: `mayWrite` admits a granted clinician, because
  // an upload under a consent grant is a legitimate act. A thumbnail is not — it is a derivative
  // minted from somebody else's record — so the read is allowed and the write is not, and such a
  // caller keeps falling back to the original forever, which is slow and correct.
  it("a granted clinician may read a thumbnail and may not write one", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p);
    await w.bucket.put(thumbKey(p.slug), sealedRawBlob(36));
    expect((await get(doc.id, p.slug, "?thumb=1")).status).toBe(200);

    await w.bucket.delete(thumbKey(p.slug));
    const res = await put(doc.id, p.slug, "?thumb=1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe("thumb_owner_only");
    expect(await w.bucket.get(thumbKey(p.slug))).toBeNull();
    // And the same caller's ordinary upload still works, so the refusal is the thumbnail's and not
    // a narrowing of what a consent grant covers.
    expect((await put(doc.id, p.slug)).status).toBe(204);
  });

  it("an unflagged PUT writes the original, so nothing about the upload path moved", async () => {
    const p = await patient("alex");
    expect((await put(p.id, p.slug)).status).toBe(204);
    expect(await w.bucket.get(thumbKey(p.slug))).toBeNull();
  });
});

describe("DELETE takes the thumbnail with the picture", () => {
  it("removes both objects and both rows, with no flag to ask for it", async () => {
    const p = await patient("alex");
    expect((await put(p.id, p.slug, "?thumb=1")).status).toBe(204);
    expect((await del(p.id, p.slug)).status).toBe(200);
    expect(await w.bucket.get(rawKey(p.slug))).toBeNull();
    expect(await w.bucket.get(thumbKey(p.slug))).toBeNull();
    expect(await rows(rawKey(p.slug))).toBeNull();
    expect(await rows(thumbKey(p.slug))).toBeNull();
  });

  it("still 200s for an attachment that never had a thumbnail", async () => {
    const p = await patient("alex");
    expect((await del(p.id, p.slug)).status).toBe(200);
    expect(await w.bucket.get(rawKey(p.slug))).toBeNull();
  });
});
