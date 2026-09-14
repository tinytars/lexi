// W73 — SECURITY.md gaps 1 and 2, closed and proven against a real D1.
//
// What was open: all five raw/text handlers and both chat-history handlers checked `requireSession` and
// then built an R2 key straight from the URL. The path segment is a CLIENT KEY — a patient's own name
// for one of their clients — which exists only inside the encrypted vault, so the server had nothing to
// compare it against. Any signed-up account could read, overwrite or delete another patient's
// *plaintext* PDFs; `document-extract` GET served their extracted text; `chat-history` PUT overwrote
// their conversation.
//
// Two patients, one clinician, one stranger, in a real database — because a fake can be made to agree
// with whatever the route does, and the whole failure being fixed here is a route that agreed with
// itself. The clinician matters as much as the stranger: a fix that locked providers out of their
// patients' attachments would "close the gap" by breaking the product.

import { applyMigrations } from "./_migrate";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database, LinkStatus } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { listRawObjectsForAccount, recordRawObject } from "../../functions/_lib/identity-audit";
import { rawAccessFor } from "../../functions/_lib/raw-owner";
import { onRequestGet as rawGet, onRequestPut as rawPut, onRequestDelete as rawDelete } from "../../functions/api/raw/[[path]]";
import { onRequestGet as extractGet } from "../../functions/api/document-extract";
import { onRequestPut as chatPut, onRequestGet as chatGet } from "../../functions/api/chat-history/[id]";
import { signSession } from "../../functions/_lib/session";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

const SECRET = "test-secret";
const STORE = "dev";
let mf: Miniflare;
let db: any;
let bucket: any;

beforeEach(async () => {
  await mf?.dispose();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: `test-rawauth-${crypto.randomUUID()}` },
    r2Buckets: { VAULT: `vault-${crypto.randomUUID()}` },
  });
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("VAULT");
  await applyMigrations(db as unknown as D1Database);
});
afterAll(async () => { await mf.dispose(); });

const env = () => ({ DB: db, VAULT: bucket, SESSION_SECRET: SECRET, STORE_PREFIX: STORE }) as any;
const cookie = async (id: string) => ({ cookie: `hd_session=${await signSession({ SESSION_SECRET: SECRET }, id)}` });

/** A patient owning client namespace `slug`, with one original and one extracted-text sidecar. */
async function patient(slug: string) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: slug, email: `${slug}@example.com` });
  await putPublicKey(db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(db, { vaultId, ownerAccountId: id, r2Key: `data-${id}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const e = await wrapDEKForPublicKey(dek, kp.publicKeyJwk);
  await putEnvelope(db, { vaultId, principalAccountId: id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: id });

  const raw = `${STORE}/raw/${slug}/report.pdf`;
  const text = `${STORE}/text/${slug}/report.pdf.json`;
  await bucket.put(raw, "PDF BYTES");
  await bucket.put(text, JSON.stringify({ text: "plaintext phi", documentKind: "x", isMedicalReport: true, notReportReason: "", chars: 13 }));
  await recordRawObject(db, raw, id);
  await recordRawObject(db, text, id);
  return { id, slug, vaultId, dek, kp };
}

async function clinicianFor(p: Awaited<ReturnType<typeof patient>>, over: { status?: LinkStatus } = {}) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "Doc", email: `${id}@clinic.test`, providerKind: "primary" });
  await putPublicKey(db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const e = await wrapDEKForPublicKey(p.dek, kp.publicKeyJwk);
  await putEnvelope(db, { vaultId: p.vaultId, principalAccountId: id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: p.id });
  await createProviderLink(db, { ownerAccountId: p.id, providerAccountId: id, role: "primary", status: over.status ?? "active", grantedBy: p.id });
  return { id };
}

async function stranger() {
  const id = crypto.randomUUID();
  await createAccount(db, { id, displayName: "S", email: `${id}@example.com` });
  return { id };
}

const getRaw = async (who: string, slug: string) =>
  rawGet({ request: new Request(`http://x/api/raw/${slug}/report.pdf`, { headers: await cookie(who) }), env: env(), params: { path: [slug, "report.pdf"] } } as any);
const putRaw = async (who: string, slug: string, file = "new.pdf") =>
  rawPut({ request: new Request(`http://x/api/raw/${slug}/${file}`, { method: "PUT", headers: await cookie(who), body: "BYTES" }), env: env(), params: { path: [slug, file] } } as any);
const deleteRaw = async (who: string, slug: string) =>
  rawDelete({ request: new Request(`http://x/api/raw/${slug}/report.pdf`, { method: "DELETE", headers: await cookie(who) }), env: env(), params: { path: [slug, "report.pdf"] } } as any);
const getText = async (who: string, slug: string) =>
  extractGet({ request: new Request(`http://x/api/document-extract?id=${slug}&key=report.pdf`, { headers: await cookie(who) }), env: env() } as any);
const putChat = async (who: string, slug: string) =>
  chatPut({ request: new Request(`http://x/api/chat-history/${slug}`, { method: "PUT", headers: await cookie(who), body: new Uint8Array([0x48, 0x44, 0x31, 1, ...new Array(40).fill(7)]) }), env: env(), params: { id: slug } } as any);
const getChat = async (who: string, slug: string) =>
  chatGet({ request: new Request(`http://x/api/chat-history/${slug}`, { headers: await cookie(who) }), env: env(), params: { id: slug } } as any);

describe("a stranger cannot reach another patient's namespace", () => {
  it.each([
    ["GET /api/raw", getRaw],
    ["DELETE /api/raw", deleteRaw],
    ["GET /api/document-extract", getText],
    ["GET /api/chat-history", getChat],
    ["PUT /api/chat-history", putChat],
  ])("%s is refused", async (_label, call) => {
    const p = await patient("pablo");
    const s = await stranger();
    expect((await call(s.id, p.slug)).status).toBe(404);
  });

  it("404, not 403 — a 403 would confirm the object exists", async () => {
    const p = await patient("pablo");
    const s = await stranger();
    const denied = await getRaw(s.id, p.slug);
    const absent = await getRaw(s.id, "no-such-client");
    expect(denied.status).toBe(absent.status);
  });

  it("an UNCLAIMED namespace is allowed, which is a stated trade and not an oversight", async () => {
    // Ownership recording began 2026-08-25 and the backfill resolves a namespace by decrypting the
    // vault with the org key — impossible for a patient who REVOKED org recovery. On dev that is one
    // real object belonging to one such patient. Refusing unclaimed reads would take their own
    // attachment away from them to protect nobody: an unclaimed namespace has no owner at risk.
    //
    // The residual (a stranger who GUESSES an unclaimed client key can read it) is in SECURITY.md, and
    // it self-heals — the first write claims the namespace.
    const s = await stranger();
    await bucket.put(`${STORE}/raw/legacy-unclaimed/old.pdf`, "PDF BYTES");
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, s.id, "legacy-unclaimed")).toEqual({ kind: "unclaimed" });
    const res = await rawGet({
      request: new Request("http://x/api/raw/legacy-unclaimed/old.pdf", { headers: await cookie(s.id) }),
      env: env(), params: { path: ["legacy-unclaimed", "old.pdf"] },
    } as any);
    expect(res.status).toBe(200);
  });

  it("but a namespace stops being unclaimed the moment anyone writes to it", async () => {
    const owner = await stranger();
    const other = await stranger();
    expect((await putRaw(owner.id, "fresh", "first.pdf")).status).toBe(204);
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, owner.id, "fresh")).toEqual({ kind: "owner" });
    expect((await getRaw(other.id, "fresh")).status).toBe(404);
  });

  it("cannot delete it either — the file is still there afterwards", async () => {
    const p = await patient("pablo");
    const s = await stranger();
    await deleteRaw(s.id, p.slug);
    expect(await bucket.get(`${STORE}/raw/${p.slug}/report.pdf`)).not.toBeNull();
  });

  it("cannot overwrite into it, and does not become its owner by trying", async () => {
    // Namespace squatting: without a PREFIX check an attacker could PUT a brand-new filename into
    // someone else's folder, become its first writer under `INSERT OR IGNORE`, and own a key inside it.
    const p = await patient("pablo");
    const s = await stranger();
    expect((await putRaw(s.id, p.slug, "squat.pdf")).status).toBe(404);
    expect(await bucket.get(`${STORE}/raw/${p.slug}/squat.pdf`)).toBeNull();
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, p.id, p.slug)).toEqual({ kind: "owner" });
  });

  it("cannot read another patient's EXTRACTED TEXT, which was the cheapest oracle of the lot", async () => {
    // document-extract's cache branch answered before it ever touched raw/, so a cross-tenant read of
    // someone's plaintext cost nothing and billed nothing.
    const p = await patient("pablo");
    const s = await stranger();
    const res = await getText(s.id, p.slug);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("plaintext phi");
  });
});

describe("the owner still has full access", () => {
  it.each([
    ["GET /api/raw", getRaw, 200],
    ["GET /api/document-extract", getText, 200],
    ["PUT /api/chat-history", putChat, 204],
  ])("%s works", async (_label, call, expected) => {
    const p = await patient("pablo");
    expect((await call(p.id, p.slug)).status).toBe(expected);
  });

  it("can still upload into their own namespace", async () => {
    const p = await patient("pablo");
    expect((await putRaw(p.id, p.slug, "another.pdf")).status).toBe(204);
  });
});

describe("a clinician with a live grant still reaches their patient's files", () => {
  // A fix that locked providers out would "close the gap" by breaking the product. Provider access is
  // exactly their envelope, decided by getEnvelope — the same accessor the vault route uses, so link
  // expiry is not re-implemented here.
  it("reads the original and the extracted text", async () => {
    const p = await patient("pablo");
    const doc = await clinicianFor(p);
    expect((await getRaw(doc.id, p.slug)).status).toBe(200);
    expect((await getText(doc.id, p.slug)).status).toBe(200);
  });

  it("loses that access when the link is revoked", async () => {
    const p = await patient("pablo");
    const doc = await clinicianFor(p, { status: "revoked" });
    expect((await getRaw(doc.id, p.slug)).status).toBe(404);
  });
});

describe("write ORDER does not decide who is locked out", () => {
  // The bug main's e2e caught, and the reason the relationship is checked in both directions.
  //
  // `raw_objects` is first-writer-wins, and the first writer into a patient's namespace is very often
  // NOT the patient — a clinician drilled in on their behalf uploads a report first. Checking only
  // "can the caller read the recorded owner's vault" then denies the PATIENT their own files.
  it("a patient still reaches files their clinician uploaded first", async () => {
    const p = await patient("pablo");
    const doc = await clinicianFor(p);

    // Wipe the seeded ownership so the clinician genuinely claims the namespace first.
    await db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(p.id).run();
    expect((await putRaw(doc.id, p.slug, "from-clinic.pdf")).status).toBe(204);
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, doc.id, p.slug)).toEqual({ kind: "owner" });

    // …and the patient, who owns the record, is not locked out of it.
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, p.id, p.slug)).toMatchObject({ kind: "granted" });
    expect((await getRaw(p.id, p.slug)).status).toBe(200);
  });

  it("but a stranger is still refused, whichever way round the relationship is missing", async () => {
    const p = await patient("pablo");
    const doc = await clinicianFor(p);
    await db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(p.id).run();
    await putRaw(doc.id, p.slug, "from-clinic.pdf");
    const s = await stranger();
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, s.id, p.slug)).toMatchObject({ kind: "denied" });
  });

  it("and a revoked link closes it in that direction too", async () => {
    const p = await patient("pablo");
    const doc = await clinicianFor(p, { status: "revoked" });
    await db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(p.id).run();
    // The clinician cannot even claim it — a revoked link is not access in either direction.
    expect((await putRaw(doc.id, p.slug, "from-clinic.pdf")).status).toBe(204); // unclaimed namespace
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, p.id, p.slug)).toMatchObject({ kind: "denied" });
  });
});

describe("two patients no longer share a namespace by having the same client name", () => {
  it("keeps them apart even when the slug collides", async () => {
    // The collision the display-name namespace always allowed: two accounts each with a client called
    // "pablo" wrote into the same folder. The first writer now owns it and the second is refused.
    const first = await patient("pablo");
    const second = await stranger();
    expect((await putRaw(second.id, "pablo", "theirs.pdf")).status).toBe(404);
    expect(await rawAccessFor(db, { STORE_PREFIX: STORE }, second.id, "pablo")).toMatchObject({ kind: "denied", ownerAccountId: first.id });
  });
});

describe("chat claims its own namespace", () => {
  it("lets a patient who has only ever chatted read their history back", async () => {
    // A patient whose first action is a conversation owns no raw/ or text/ objects at all. If chat did
    // not claim the namespace, their own history would read as unclaimed and 404 on them.
    const id = crypto.randomUUID();
    await createAccount(db, { id, displayName: "chatty", email: "c@example.com" });
    expect((await putChat(id, "chatty")).status).toBe(204);
    expect((await getChat(id, "chatty")).status).toBe(200);
    // …and a stranger still cannot.
    const s = await stranger();
    expect((await getChat(s.id, "chatty")).status).toBe(404);
  });
});

describe("an unclaimed namespace is readable but NOT destroyable (W75)", () => {
  const seedUnclaimed = async () => {
    await bucket.put(`${STORE}/raw/legacy-unclaimed/report.pdf`, "PDF BYTES");
  };

  it("refuses DELETE where it allows GET", async () => {
    // Every clause of the permissive-unclaimed argument is about a read, or about a first write that
    // CLAIMS the namespace and so closes the window. A delete is neither: there is no first deleter,
    // nothing self-heals, and the bytes destroyed are plaintext PHI with no undo. On prod, before the
    // ownership backfill, every namespace was unclaimed as soon as objects appeared.
    const s = await stranger();
    await seedUnclaimed();

    expect((await getRaw(s.id, "legacy-unclaimed")).status).toBe(200);
    expect((await deleteRaw(s.id, "legacy-unclaimed")).status).toBe(404);
    expect(await bucket.get(`${STORE}/raw/legacy-unclaimed/report.pdf`)).not.toBeNull();
  });

  it("lets the account that claimed it by writing delete it afterwards", async () => {
    // The refusal must not become a permanent orphan: writing claims the namespace, and the owner can
    // then clean up. This is the path a real patient takes out of the unclaimed state.
    const s = await stranger();
    await seedUnclaimed();
    expect((await putRaw(s.id, "legacy-unclaimed", "mine.pdf")).status).toBe(204);
    expect((await deleteRaw(s.id, "legacy-unclaimed")).status).toBe(200);
    expect(await bucket.get(`${STORE}/raw/legacy-unclaimed/report.pdf`)).toBeNull();
  });
});

describe("deleting an original releases its ownership row", () => {
  it("does not leave an orphan that erasure would count forever", async () => {
    const p = await patient("pablo");
    expect((await deleteRaw(p.id, p.slug)).status).toBe(200);
    const rows = await listRawObjectsForAccount(db, p.id);
    expect(rows).not.toContain(`${STORE}/raw/${p.slug}/report.pdf`);
  });
});
