// Real D1 + R2: a fake can be made to agree with whatever the route does, which is the failure being fixed.
import { describe, it, expect } from "vitest";
import type { LinkStatus } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { listRawObjectsForAccount, recordRawObject } from "../../functions/_lib/identity-audit";
import { rawAccessFor } from "../../functions/_lib/raw-owner";
import { onRequestPost as claimPost } from "../../functions/api/raw/claim";
import { onRequestGet as rawGet, onRequestPut as rawPut, onRequestDelete as rawDelete } from "../../functions/api/raw/[[path]]";
import { onRequestGet as extractGet } from "../../functions/api/document-extract";
import { onRequestPut as chatPut, onRequestGet as chatGet } from "../../functions/api/chat-history/[id]";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";
import { hd1Blob } from "../support/blobs";

const STORE = "dev";
// Fixtures reuse fixed client names ("alex", "legacy"), so each test needs its own namespace table.
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

/** Nothing written yet: no objects and no ownership rows, so the namespace is genuinely EMPTY. */
async function wipe(slug: string) {
  for (const k of [`${STORE}/raw/${slug}/report.pdf`, `${STORE}/text/${slug}/report.pdf.json`]) await w.bucket.delete(k);
  await w.db.prepare("DELETE FROM raw_objects WHERE r2_key LIKE ?").bind(`%/${slug}/%`).run();
}

async function stranger() {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: "S", email: `${id}@example.com` });
  return { id };
}

const getRaw = async (who: string, slug: string, file = "report.pdf") =>
  rawGet({ request: new Request(`http://x/api/raw/${slug}/${file}`, { headers: await cookie(who) }), env: env(), params: { path: [slug, file] } } as any);
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

  it("an ORPHANED namespace (objects, no owner) is refused like any other that is not yours", async () => {
    const s = await stranger();
    await w.bucket.put(`${STORE}/raw/legacy/old.pdf`, "PDF BYTES");
    expect(await rawAccessFor(w.db, env(), s.id, "legacy")).toEqual({ kind: "orphaned" });
    const res = await rawGet({
      request: new Request("http://x/api/raw/legacy/old.pdf", { headers: await cookie(s.id) }),
      env: env(), params: { path: ["legacy", "old.pdf"] },
    } as any);
    expect(res.status).toBe(404);
  });

  it("but a namespace stops being unclaimed the moment anyone writes to it", async () => {
    const owner = await stranger();
    const other = await stranger();
    expect(await rawAccessFor(w.db, env(), owner.id, "fresh")).toEqual({ kind: "unclaimed" });
    expect((await putRaw(owner.id, "fresh", "first.pdf")).status).toBe(204);
    expect(await rawAccessFor(w.db, env(), owner.id, "fresh")).toEqual({ kind: "owner" });
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
    expect(await rawAccessFor(w.db, env(), p.id, p.slug)).toEqual({ kind: "owner" });
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

    // Wipe the seeded namespace so the clinician genuinely writes into it first.
    await wipe(p.slug);
    expect((await putRaw(doc.id, p.slug, "from-clinic.pdf")).status).toBe(204);
    expect(await rawAccessFor(w.db, env(), doc.id, p.slug)).toEqual({ kind: "owner" });

    // …and the patient, who owns the record, is not locked out of it.
    expect(await rawAccessFor(w.db, env(), p.id, p.slug)).toMatchObject({ kind: "granted" });
    expect((await getRaw(p.id, p.slug, "from-clinic.pdf")).status).toBe(200);
  });

  it("but a stranger is still refused, whichever way round the relationship is missing", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p);
    await wipe(p.slug);
    await putRaw(doc.id, p.slug, "from-clinic.pdf");
    const s = await stranger();
    expect(await rawAccessFor(w.db, env(), s.id, p.slug)).toMatchObject({ kind: "denied" });
  });

  it("and a revoked link closes it in that direction too", async () => {
    const p = await patient("alex");
    const doc = await clinicianFor(p, { status: "revoked" });
    await wipe(p.slug);
    expect((await putRaw(doc.id, p.slug, "from-clinic.pdf")).status).toBe(204); // empty namespace: the clinician claims it
    expect(await rawAccessFor(w.db, env(), p.id, p.slug)).toMatchObject({ kind: "denied" });
  });
});

describe("two patients no longer share a namespace by having the same client name", () => {
  it("keeps them apart even when the slug collides", async () => {
    const first = await patient("alex");
    const second = await stranger();
    expect((await putRaw(second.id, "alex", "theirs.pdf")).status).toBe(404);
    expect(await rawAccessFor(w.db, env(), second.id, "alex")).toMatchObject({ kind: "denied", ownerAccountId: first.id });
  });
});

describe("a namespace with rows from two accounts has one stable owner", () => {
  it("is owned by the earliest writer, whatever order the rows were inserted in", async () => {
    const first = await patient("alex");
    const later = await stranger();
    await w.db
      .prepare("INSERT INTO raw_objects (r2_key, account_id, created_at) VALUES (?, ?, '2026-09-19T00:00:00Z')")
      .bind(`${STORE}/raw/alex/late.pdf`, later.id)
      .run();
    // The earlier writer's rows re-inserted AFTER, so neither rowid nor key order favours them.
    await w.db.prepare("DELETE FROM raw_objects WHERE account_id = ?").bind(first.id).run();
    for (const key of [`${STORE}/raw/alex/report.pdf`, `${STORE}/text/alex/report.pdf.json`]) {
      await w.db
        .prepare("INSERT INTO raw_objects (r2_key, account_id, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')")
        .bind(key, first.id)
        .run();
    }
    expect(await rawAccessFor(w.db, env(), first.id, "alex")).toMatchObject({ kind: "owner" });
    expect(await rawAccessFor(w.db, env(), later.id, "alex")).toMatchObject({ kind: "denied", ownerAccountId: first.id });
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

describe("an orphaned namespace is untouchable until it is legitimately claimed (W76)", () => {
  const ORIGINAL = "PDF BYTES OF A LEGACY REPORT";
  const seedOrphan = async () => {
    await w.bucket.put(`${STORE}/raw/legacy/report.pdf`, ORIGINAL);
    await w.bucket.put(`${STORE}/text/legacy/report.pdf.json`, JSON.stringify({ text: "plaintext phi", documentKind: "x", isMedicalReport: true, notReportReason: "", chars: 13 }));
    await w.bucket.put(`${STORE}/chat-legacy.enc`, hd1Blob());
  };
  const sha256 = async (s: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const claim = async (who: string, clientId: string, proofs: { file: string; sha256: string }[]) =>
    claimPost({
      request: new Request("http://x/api/raw/claim", { method: "POST", headers: { ...(await cookie(who)), "content-type": "application/json" }, body: JSON.stringify({ clientId, proofs }) }),
      env: env(),
    } as any);
  const ownerRows = async () => (await w.db.prepare("SELECT count(*) AS n FROM raw_objects").first<{ n: number }>())!.n;

  it.each([
    ["GET /api/raw", getRaw],
    ["DELETE /api/raw", deleteRaw],
    ["GET /api/document-extract", getText],
    ["GET /api/chat-history", getChat],
    ["PUT /api/chat-history", putChat],
  ])("%s is refused", async (_label, call) => {
    const s = await stranger();
    await seedOrphan();
    expect((await call(s.id, "legacy")).status).toBe(404);
  });

  it("cannot be squatted: a first PUT neither lands nor makes the writer its owner", async () => {
    // Before W76 this PUT claimed the namespace, after which the same account could delete the legacy original.
    const s = await stranger();
    await seedOrphan();
    expect((await putRaw(s.id, "legacy", "mine.pdf")).status).toBe(404);
    expect(await w.bucket.get(`${STORE}/raw/legacy/mine.pdf`)).toBeNull();
    expect(await ownerRows()).toBe(0);
    expect((await deleteRaw(s.id, "legacy")).status).toBe(404);
    expect(await w.bucket.get(`${STORE}/raw/legacy/report.pdf`)).not.toBeNull();
  });

  it("is claimed, whole, by proving a stored original's full SHA-256", async () => {
    const owner = await stranger();
    await seedOrphan();
    const res = await claim(owner.id, "legacy", [{ file: "report.pdf", sha256: await sha256(ORIGINAL) }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 3 });
    expect(await rawAccessFor(w.db, env(), owner.id, "legacy")).toEqual({ kind: "owner" });
    expect((await getRaw(owner.id, "legacy")).status).toBe(200);
    expect((await getText(owner.id, "legacy")).status).toBe(200);
    expect((await getChat(owner.id, "legacy")).status).toBe(200);
    // …and it is now owned, so a stranger is refused as `denied`, not merely as orphaned.
    const s = await stranger();
    expect(await rawAccessFor(w.db, env(), s.id, "legacy")).toMatchObject({ kind: "denied", ownerAccountId: owner.id });
  });

  it.each([
    ["a wrong hash", async () => [{ file: "report.pdf", sha256: await sha256("something else") }]],
    ["the right hash for a file that isn't there", async () => [{ file: "nope.pdf", sha256: await sha256(ORIGINAL) }]],
  ])("is refused on %s, and writes nothing", async (_label, proofs) => {
    const s = await stranger();
    await seedOrphan();
    expect((await claim(s.id, "legacy", await proofs())).status).toBe(404);
    expect(await ownerRows()).toBe(0);
  });

  it("a sha8 prefix is not a proof — it is already in the filename", async () => {
    const s = await stranger();
    await seedOrphan();
    expect((await claim(s.id, "legacy", [{ file: "report.pdf", sha256: (await sha256(ORIGINAL)).slice(0, 8) }])).status).toBe(400);
    expect(await ownerRows()).toBe(0);
  });

  it("claims nothing that is not orphaned: someone else's namespace, or an empty one", async () => {
    const p = await patient("alex");
    const s = await stranger();
    const pdfHash = await sha256("PDF BYTES");
    expect((await claim(s.id, p.slug, [{ file: "report.pdf", sha256: pdfHash }])).status).toBe(404);
    expect(await rawAccessFor(w.db, env(), s.id, p.slug)).toMatchObject({ kind: "denied", ownerAccountId: p.id });
    expect((await claim(s.id, "empty", [{ file: "report.pdf", sha256: pdfHash }])).status).toBe(404);
    expect(await rawAccessFor(w.db, env(), s.id, "empty")).toEqual({ kind: "unclaimed" });
  });

  it("is a no-op 204 for the owner, so the client may call it on every vault open", async () => {
    const p = await patient("alex");
    const before = await ownerRows();
    expect((await claim(p.id, p.slug, [{ file: "report.pdf", sha256: await sha256("anything") }])).status).toBe(204);
    expect(await ownerRows()).toBe(before);
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
