// Who a raw read is ABOUT, on a real D1 + R2.
//
// `raw_objects` ownership is first-writer-wins, and the first writer into a patient's namespace is very
// often the clinician who uploaded the report on their behalf (functions/_lib/raw-owner.ts). So the
// namespace's `ownerAccountId` is not the person whose record it is, and filing it as the audit row's
// subject would put a disclosure on the CLINICIAN's screen and none on the patient's. The vault owner is
// the person. These tests pin that distinction in the direction that used to get it wrong.
import { describe, it, expect } from "vitest";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { recordRawObject, listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { rawAccessFor } from "../../functions/_lib/raw-owner";
import { onRequestGet as rawGet } from "../../functions/api/raw/[[path]]";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const STORE = "dev";
const SLUG = "alex";
const FILE = "deadbeef-Blood Panel March 2026.pdf";
const w = useWorkerd({ r2: true, perTest: true });

const env = () => ({ DB: w.db, VAULT: w.bucket, SESSION_SECRET, STORE_PREFIX: STORE }) as never;

const getRaw = async (who: string, path = `${SLUG}/${FILE}`) =>
  rawGet({
    request: new Request(`http://x/api/raw/${path}`, { headers: { cookie: await cookieFor(who) } }),
    env: env(),
    params: { path: path.split("/") },
  });

/**
 * A patient who owns the vault and a clinician holding a live envelope on it, with `firstWriter` deciding
 * which of them `raw_objects` records as the namespace's owner. Write ORDER is the whole variable here:
 * it does not change who the record belongs to, and it used to change who the audit row named.
 */
async function pair(firstWriter: "patient" | "clinician") {
  const patientKp = await generateAccountKeypair();
  const patientId = crypto.randomUUID();
  await createAccount(w.db, { id: patientId, displayName: "Patient", email: `${patientId}@example.com` });
  await putPublicKey(w.db, { accountId: patientId, publicKeyJwk: patientKp.publicKeyJwk });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: patientId, r2Key: `data-${patientId}.enc`, hd1Version: 2 });
  const dek = await generateDEK();
  const own = await wrapDEKForPublicKey(dek, patientKp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: patientId, wrappedDek: own.wrappedDEK, ephemeralPublicKeyJwk: own.ephemeralPublicKeyJwk, createdBy: patientId });

  const clinicianKp = await generateAccountKeypair();
  const clinicianId = crypto.randomUUID();
  await createAccount(w.db, { id: clinicianId, displayName: "Doc", email: `${clinicianId}@clinic.test`, providerKind: "primary" });
  await putPublicKey(w.db, { accountId: clinicianId, publicKeyJwk: clinicianKp.publicKeyJwk });
  const shared = await wrapDEKForPublicKey(dek, clinicianKp.publicKeyJwk);
  await putEnvelope(w.db, { vaultId, principalAccountId: clinicianId, wrappedDek: shared.wrappedDEK, ephemeralPublicKeyJwk: shared.ephemeralPublicKeyJwk, createdBy: patientId });
  await createProviderLink(w.db, { ownerAccountId: patientId, providerAccountId: clinicianId, role: "primary", status: "active", grantedBy: patientId, consentRef: "consent-alex" });

  const key = `${STORE}/raw/${SLUG}/${FILE}`;
  await w.bucket.put(key, "PDF BYTES");
  await recordRawObject(w.db, key, firstWriter === "patient" ? patientId : clinicianId);
  return { patientId, clinicianId, vaultId };
}

describe("a raw read is audited against the vault's owner, not the namespace's first writer", () => {
  it("files the clinician's read on the PATIENT's log, with the consent it is exercising", async () => {
    const { patientId, clinicianId, vaultId } = await pair("patient");

    expect((await getRaw(clinicianId)).status).toBe(200);

    const events = await listAccessEventsForSubject(w.db, patientId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorAccountId: clinicianId,
      subjectAccountId: patientId,
      vaultId,
      action: "raw_object_read",
      consentRef: "consent-alex",
      meta: { sha8: "deadbeef" },
    });
  });

  it("never names the clinician as the subject of a read of their own patient's file", async () => {
    const { clinicianId } = await pair("patient");
    await getRaw(clinicianId);
    expect(await listAccessEventsForSubject(w.db, clinicianId)).toHaveLength(0);
  });

  it("records nothing when the patient reads a file their clinician uploaded first", async () => {
    // The namespace's recorded owner is the CLINICIAN here, so the reverse candidate is what matches —
    // and its vault owner is the caller, which the owner exclusion then skips. Reading `ownerAccountId`
    // instead wrote a row naming the clinician as the person whose record the patient had just read.
    const { patientId, clinicianId } = await pair("clinician");

    expect((await getRaw(patientId)).status).toBe(200);

    expect(await listAccessEventsForSubject(w.db, patientId)).toHaveLength(0);
    expect(await listAccessEventsForSubject(w.db, clinicianId)).toHaveLength(0);
  });

  it("records one row per object, so the log answers which documents were disclosed", async () => {
    const { patientId, clinicianId } = await pair("patient");
    const second = `${STORE}/raw/${SLUG}/cafebabe-Scan.pdf`;
    await w.bucket.put(second, "PDF BYTES");
    await recordRawObject(w.db, second, clinicianId);

    await getRaw(clinicianId);
    await getRaw(clinicianId, `${SLUG}/cafebabe-Scan.pdf`);

    expect((await listAccessEventsForSubject(w.db, patientId)).map((e) => e.meta)).toEqual([
      { sha8: "deadbeef" },
      { sha8: "cafebabe" },
    ]);
  });

  it("audits a listing by count, never by filename", async () => {
    const { patientId, clinicianId } = await pair("patient");

    const res = await rawGet({
      request: new Request(`http://x/api/raw/${SLUG}?files=1`, { headers: { cookie: await cookieFor(clinicianId) } }),
      env: env(),
      params: { path: [SLUG] },
    });
    expect(res.status).toBe(200);

    const events = await listAccessEventsForSubject(w.db, patientId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "raw_namespace_listed", meta: { count: 1 } });
    expect(JSON.stringify(events[0].meta)).not.toContain("Blood");
  });

  it("costs exactly one extra provider_links read to learn the consent reference", async () => {
    const { patientId, clinicianId } = await pair("patient");
    const sql: string[] = [];
    const counting = { prepare: (q: string) => (sql.push(q), w.db.prepare(q)) } as unknown as D1Database;

    const access = await rawAccessFor(counting, { VAULT: w.bucket, STORE_PREFIX: STORE } as never, clinicianId, SLUG);

    expect(access).toMatchObject({ kind: "granted", subjectAccountId: patientId, consentRef: "consent-alex" });
    // Two reads, and only one of them is ours: @tinytars/vault's resolveEnvelopeAccess already fetches
    // this exact link to decide access and then discards it. Having it hand the link back would make our
    // read free, but that is an upstream change and a version bump — deliberately deferred to the next
    // time the pin moves. This number is the receipt for that decision, so raising it is a choice.
    expect(sql.filter((q) => q.includes("provider_links"))).toHaveLength(2);
  });
});
