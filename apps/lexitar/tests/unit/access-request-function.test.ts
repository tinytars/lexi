// One handler, two mounts: /api/providers/request (new) and /api/support/request (unchanged, two
// shipped consumers). The tests below are mostly about the *asker*, because that is what the
// extraction made variable — the old body hardcoded `role: "support"`, and a clinician's request
// written with that role is a row the patient's screen cannot offer an Approve for.
//
// The audit assertions are the other half and are not decoration: `functions/_lib/erasure.ts` never
// deletes `phi_access_events`, so a name written here is permanent and a name written by the wrong
// branch is permanent too. tests/unit/audit-chokepoint.test.ts holds the vocabulary closed; these
// hold each branch to the name it is meant to write.
import { describe, it, expect } from "vitest";
import { onRequestPost as providerRequest } from "../../functions/api/providers/request";
import { onRequestPost as supportRequest } from "../../functions/api/support/request";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { createVault } from "../../functions/_lib/identity-vault";
import { listProvidersForPatient } from "../../functions/_lib/identity-providers";
import { listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const w = useWorkerd();
const makeEnv = () => ({ DB: w.db, SESSION_SECRET }) as any;

async function ask(fn: any, actorId: string, ownerEmail: string) {
  return fn({
    request: new Request("http://x", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor(actorId) },
      body: JSON.stringify({ ownerEmail }),
    }),
    env: makeEnv(),
  });
}

async function seedProvider(kind: "primary" | "support" = "primary") {
  const id = crypto.randomUUID();
  const email = `${kind}-${id}@x.test`;
  await createAccount(w.db, { id, displayName: "Dr Who", email, providerKind: kind });
  return { id, email };
}

async function seedPatient() {
  const id = crypto.randomUUID();
  const email = `pat-${id}@x.test`;
  await createAccount(w.db, { id, displayName: "Pat", email });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: id, r2Key: `data-${id}.enc`, hd1Version: 2 });
  return { id, email, vaultId };
}

describe("a clinician asks a patient for access", () => {
  it("creates an invited link that records the CLINICIAN as the asker, and audits it", async () => {
    const doc = await seedProvider();
    const pat = await seedPatient();

    const res = await ask(providerRequest, doc.id, pat.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, linkId: expect.any(String), status: "invited", target: "patient" });

    // `role`, not the route's name. The patient's screen reads this column to decide whether
    // approving means wrapping a DEK (primary) or flipping a flag (support).
    const links = await listProvidersForPatient(w.db, pat.id);
    expect(links).toEqual([expect.objectContaining({ providerAccountId: doc.id, role: "primary", status: "invited" })]);

    const events = await listAccessEventsForSubject(w.db, pat.id);
    expect(events.map((e) => e.action)).toEqual(["provider_access_requested"]);
    // The subject is the patient, so the row lands on THEIR access screen rather than the asker's.
    expect(events[0]).toMatchObject({ actorAccountId: doc.id, subjectAccountId: pat.id, vaultId: pat.vaultId });
  });

  it("refuses a patient caller, so nobody can put a pending row on another person's screen", async () => {
    const pat = await seedPatient();
    const other = await seedPatient();
    const res = await ask(providerRequest, pat.id, other.email);
    expect(res.status).toBe(403);
    expect(await listProvidersForPatient(w.db, other.id)).toEqual([]);
    expect(await listAccessEventsForSubject(w.db, other.id)).toEqual([]);
  });

  it("refuses clinician → clinician, which neither console has a row for", async () => {
    const a = await seedProvider();
    const b = await seedProvider();
    const res = await ask(providerRequest, a.id, b.email);
    expect(res.status).toBe(400);
    expect(await listProvidersForPatient(w.db, b.id)).toEqual([]);
  });

  it("refuses a support target, who has neither a record nor a roster to share", async () => {
    const doc = await seedProvider();
    const sup = await seedProvider("support");
    expect((await ask(providerRequest, doc.id, sup.email)).status).toBe(400);
  });

  it("is idempotent: asking twice returns the standing link and writes no second row", async () => {
    const doc = await seedProvider();
    const pat = await seedPatient();

    const first = (await (await ask(providerRequest, doc.id, pat.email)).json()) as { linkId: string };
    const again = await ask(providerRequest, doc.id, pat.email);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, linkId: first.linkId, status: "invited" });

    expect(await listProvidersForPatient(w.db, pat.id)).toHaveLength(1);
    // The sharper half: a second audit row would read as a second ask on the patient's own log.
    expect(await listAccessEventsForSubject(w.db, pat.id)).toHaveLength(1);
  });
});

// The extraction is the risk here, not the new path: /api/support/request is unchanged in the URL
// and in two shipped consumers, and its body is now shared code.
describe("the support mount still behaves as it did", () => {
  it("records a support ask against a patient under its own frozen name", async () => {
    const sup = await seedProvider("support");
    const pat = await seedPatient();

    const res = await ask(supportRequest, sup.id, pat.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "invited", target: "patient" });
    expect(await listProvidersForPatient(w.db, pat.id)).toEqual([
      expect.objectContaining({ providerAccountId: sup.id, role: "support", status: "invited" }),
    ]);
    expect((await listAccessEventsForSubject(w.db, pat.id)).map((e) => e.action)).toEqual(["support_access_requested"]);
  });

  it("records a support ask for a clinician's roster as a roster request, with no vault", async () => {
    const sup = await seedProvider("support");
    const doc = await seedProvider();

    const res = await ask(supportRequest, sup.id, doc.email);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ target: "provider" });
    const events = await listAccessEventsForSubject(w.db, doc.id);
    expect(events.map((e) => e.action)).toEqual(["support_provider_access_requested"]);
    expect(events[0].vaultId).toBeNull();
  });

  it("serves the clinician mount too, so the two are one body and not two copies", async () => {
    const sup = await seedProvider("support");
    const pat = await seedPatient();
    const res = await ask(providerRequest, sup.id, pat.email);
    expect(res.status).toBe(200);
    expect((await listProvidersForPatient(w.db, pat.id))[0]).toMatchObject({ role: "support" });
  });
});
