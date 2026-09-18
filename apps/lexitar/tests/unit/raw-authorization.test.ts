// Real D1 + R2: a fake can be made to agree with whatever the route does, which is the failure being fixed.
import { describe, it, expect } from "vitest";
import type { LinkStatus } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { listRawObjectsForAccount, recordRawObject } from "../../functions/_lib/identity-audit";
import { rawAccessFor } from "../../functions/_lib/raw-owner";
import { onRequestGet as rawGet, onRequestPut as rawPut, onRequestDelete as rawDelete } from "../../functions/api/raw/[[path]]";
import { onRequestGet as extractGet } from "../../functions/api/document-extract";
import { onRequestPut as chatPut, onRequestGet as chatGet } from "../../functions/api/chat-history/[id]";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { hd1Blob } from "../support/blobs";

const STORE = "dev";
// Fixtures reuse fixed client names ("alex", "legacy-unclaimed"), so each test needs its own namespace table.
const w = useWorkerd({ r2: true, perTest: true });

const env = () => ({ DB: w.db, VAULT: w.bucket, SESSION_SECRET, STORE_PREFIX: STORE }) as any;
const cookie = async (id: string) => ({ cookie: await cookieFor(id) });

/** A patient owning client namespace `slug`, with one original and one extracted-text sidecar. */
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

  const raw = `${STORE}/raw/${slug}/report.pdf`;
  const text = `${STORE}/text/${slug}/report.pdf.json`;
  await w.bucket.put(raw, "PDF BYTES");
  await w.bucket.put(text, JSON.stringify({ text: "plaintext phi", documentKind: "x", isMedicalReport: true, notReportReason: "", chars: 13 }));
  await recordRawObject(w.db, raw, id);
  await recordRawObject(w.db, text, id);
  return { id, slug, vaultId, dek, kp };
}

async function clinicianFor(p: Awaited<ReturnType<typeof patient>>, over: { status?: LinkStatus } = {}) {
  const kp = await generateAccountKeypair();
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "Doc", email: `${id}@clinic.test`, providerKind: "primary" });
  await putPublicKey(w.db, { accountId: id, publicKeyJwk: kp.publicKeyJwk });
  const e = await wrapDEKForPublicKey(p.dek, kp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId: p.vaultId, principalAccountId: id, wrappedDek: e.wrappedDEK, ephemeralPublicKeyJwk: e.ephemeralPublicKeyJwk, createdBy: p.id });
  await createProviderLink(w.db, { ownerAccountId: p.id, providerAccountId: id, role: "primary", status: over.status ?? "active", grantedBy: p.id });
  return { id };
}

async function stranger() {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "S", email: `${id}@example.com` });
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
  chatPut({ request: new Request(`http://x/api/chat-history/${slug}`, { method: "PUT", headers: await cookie(who), body: hd1Blob() }), env: env(), params: { id: slug } } as any);
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
    const p = await patient("alex");
    const s = await stranger();
    expect((await call(s.id, p.slug)).status).toBe(404);
  });

  it("404, not 403 — a 403 would confirm the object exists", async () => {
    const p = await patient("alex");
    const s = await stranger();
    const denied = await getRaw(s.id, p.slug);
    const absent = await getRaw(s.id, "no-such-client");
    expect(denied.status).toBe(absent.status);
  });

  it("an UNCLAIMED namespace is allowed, which is a stated trade and not an oversight", async () => {
    // Refusing unclaimed reads would strand patients who revoked org recovery (backfill can't attribute them); residual is in SECURITY.md.
    const s = await stranger();
    await w.bucket.put(`${STORE}/raw/legacy-unclaimed/old.pdf`, "PDF BYTES");
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, s.id, "legacy-unclaimed")).toEqual({ kind: "unclaimed" });
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
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, owner.id, "fresh")).toEqual({ kind: "owner" });
    expect((await getRaw(other.id, "fresh")).status).toBe(404);
  });

  it("cannot delete it either — the file is still there afterwards", async () => {
    const p = await patient("alex");
    const s = await stranger();
    await deleteRaw(s.id, p.slug);
    expect(await w.bucket.get(`${STORE}/raw/${p.slug}/report.pdf`)).not.toBeNull();
  });

  it("cannot overwrite into it, and does not become its owner by trying", async () => {
    // Squatting: a first write under INSERT OR IGNORE would otherwise make the attacker an owner inside the folder.
    const p = await patient("alex");
    const s = await stranger();
    expect((await putRaw(s.id, p.slug, "squat.pdf")).status).toBe(404);
    expect(await w.bucket.get(`${STORE}/raw/${p.slug}/squat.pdf`)).toBeNull();
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, p.id, p.slug)).toEqual({ kind: "owner" });
  });

  it("cannot read another patient's EXTRACTED TEXT, which was the cheapest oracle of the lot", async () => {
    // The extract cache branch used to answer before raw/ was consulted, so this read was free.
    const p = await patient("alex");
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
    const p = await patient("alex");
    expect((await call(p.id, p.slug)).status).toBe(expected);
  });

  it("can still upload into their own namespace", async () => {
    const p = await patient("alex");
    expect((await putRaw(p.id, p.slug, "another.pdf")).status).toBe(204);
  });
});

describe("a clinician with a live grant still reaches their patient's files", () => {
  // Provider access is exactly their envelope (getEnvelope), so link expiry is not re-checked here.
  it("reads the original and the extracted text", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p);
    expect((await getRaw(doc.id, p.slug)).status).toBe(200);
    expect((await getText(doc.id, p.slug)).status).toBe(200);
  });

  it("loses that access when the link is revoked", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p, { status: "revoked" });
    expect((await getRaw(doc.id, p.slug)).status).toBe(404);
  });
});

describe("write ORDER does not decide who is locked out", () => {
  // raw_objects is first-writer-wins and a clinician often writes first, so the relationship is checked both ways.
  it("a patient still reaches files their clinician uploaded first", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p);

    // Wipe the seeded ownership so the clinician genuinely claims the namespace first.
    await w.db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(p.id).run();
    expect((await putRaw(doc.id, p.slug, "from-clinic.pdf")).status).toBe(204);
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, doc.id, p.slug)).toEqual({ kind: "owner" });

    // …and the patient, who owns the record, is not locked out of it.
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, p.id, p.slug)).toMatchObject({ kind: "granted" });
    expect((await getRaw(p.id, p.slug)).status).toBe(200);
  });

  it("but a stranger is still refused, whichever way round the relationship is missing", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p);
    await w.db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(p.id).run();
    await putRaw(doc.id, p.slug, "from-clinic.pdf");
    const s = await stranger();
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, s.id, p.slug)).toMatchObject({ kind: "denied" });
  });

  it("and a revoked link closes it in that direction too", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p, { status: "revoked" });
    await w.db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(p.id).run();
    // The clinician cannot even claim it — a revoked link is not access in either direction.
    expect((await putRaw(doc.id, p.slug, "from-clinic.pdf")).status).toBe(204); // unclaimed namespace
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, p.id, p.slug)).toMatchObject({ kind: "denied" });
  });
});

describe("two patients no longer share a namespace by having the same client name", () => {
  it("keeps them apart even when the slug collides", async () => {
    const first = await patient("alex");
    const second = await stranger();
    expect((await putRaw(second.id, "alex", "theirs.pdf")).status).toBe(404);
    expect(await rawAccessFor(w.db, { STORE_PREFIX: STORE }, second.id, "alex")).toMatchObject({ kind: "denied", ownerAccountId: first.id });
  });
});

describe("chat claims its own namespace", () => {
  it("lets a patient who has only ever chatted read their history back", async () => {
    // A chat-only patient owns no raw/ objects; unless chat claims the namespace their history reads as unclaimed.
    const id = crypto.randomUUID();
    await createAccount(w.db, { id, displayName: "chatty", email: "c@example.com" });
    expect((await putChat(id, "chatty")).status).toBe(204);
    expect((await getChat(id, "chatty")).status).toBe(200);
    // …and a stranger still cannot.
    const s = await stranger();
    expect((await getChat(s.id, "chatty")).status).toBe(404);
  });
});

describe("an unclaimed namespace is readable but NOT destroyable (W75)", () => {
  const seedUnclaimed = async () => {
    await w.bucket.put(`${STORE}/raw/legacy-unclaimed/report.pdf`, "PDF BYTES");
  };

  it("refuses DELETE where it allows GET", async () => {
    // No first deleter and nothing self-heals: a delete destroys plaintext PHI with no undo.
    const s = await stranger();
    await seedUnclaimed();

    expect((await getRaw(s.id, "legacy-unclaimed")).status).toBe(200);
    expect((await deleteRaw(s.id, "legacy-unclaimed")).status).toBe(404);
    expect(await w.bucket.get(`${STORE}/raw/legacy-unclaimed/report.pdf`)).not.toBeNull();
  });

  it("lets the account that claimed it by writing delete it afterwards", async () => {
    // Writing claims the namespace, so the refusal never leaves a permanent orphan.
    const s = await stranger();
    await seedUnclaimed();
    expect((await putRaw(s.id, "legacy-unclaimed", "mine.pdf")).status).toBe(204);
    expect((await deleteRaw(s.id, "legacy-unclaimed")).status).toBe(200);
    expect(await w.bucket.get(`${STORE}/raw/legacy-unclaimed/report.pdf`)).toBeNull();
  });
});

describe("deleting an original releases its ownership row", () => {
  it("does not leave an orphan that erasure would count forever", async () => {
    const p = await patient("alex");
    expect((await deleteRaw(p.id, p.slug)).status).toBe(200);
    const rows = await listRawObjectsForAccount(w.db, p.id);
    expect(rows).not.toContain(`${STORE}/raw/${p.slug}/report.pdf`);
  });
});
