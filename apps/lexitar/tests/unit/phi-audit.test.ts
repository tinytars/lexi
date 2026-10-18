// The owner exclusion and the fail-closed refusal, pinned on a real D1 — the two properties every
// privileged route inherits from functions/_lib/phi-audit.ts rather than implementing for itself.
import { describe, it, expect } from "vitest";
import type { D1Database } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { auditPrivilegedRead, sha8Of, AUDIT_UNAVAILABLE } from "../../functions/_lib/phi-audit";
import { listAccessEventsForSubject } from "../../functions/_lib/identity-audit";
import { useWorkerd } from "../support/miniflare";

const w = useWorkerd();

async function account(name: string) {
  const id = crypto.randomUUID();
  await createAccount(w.db, { id, displayName: name, email: `${id}@example.com` });
  return id;
}

describe("auditPrivilegedRead", () => {
  it("writes nothing when the caller is the subject, because that is not a disclosure", async () => {
    const me = await account("Owner");
    expect(await auditPrivilegedRead(w.db, { actor: me, subject: me, action: "vault_blob_read" })).toBeNull();
    expect(await listAccessEventsForSubject(w.db, me)).toHaveLength(0);
  });

  it("writes one row on the subject's own log when someone else reads", async () => {
    const patient = await account("Patient");
    const clinician = await account("Clinician");

    expect(
      await auditPrivilegedRead(w.db, {
        actor: clinician,
        subject: patient,
        vaultId: "vault-1",
        action: "raw_object_read",
        consentRef: "consent-7",
        meta: { sha8: "deadbeef" },
      })
    ).toBeNull();

    const events = await listAccessEventsForSubject(w.db, patient);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorAccountId: clinician,
      subjectAccountId: patient,
      vaultId: "vault-1",
      action: "raw_object_read",
      consentRef: "consent-7",
      meta: { sha8: "deadbeef" },
    });
    // The row belongs to the person read, not to the person reading.
    expect(await listAccessEventsForSubject(w.db, clinician)).toHaveLength(0);
  });

  it("refuses the read with a named 503 when the row cannot be written", async () => {
    const broken = {
      prepare() {
        throw new Error("D1_ERROR: no such table");
      },
    } as unknown as D1Database;

    const refused = await auditPrivilegedRead(broken, { actor: "a", subject: "b", action: "vault_blob_read" });
    expect(refused?.status).toBe(503);
    expect(await refused!.json()).toMatchObject({ errorCode: AUDIT_UNAVAILABLE });
  });

  it("serves an owner even when the log is broken, which is what makes failing closed safe", async () => {
    const broken = { prepare: () => { throw new Error("D1_ERROR"); } } as unknown as D1Database;
    expect(await auditPrivilegedRead(broken, { actor: "a", subject: "a", action: "vault_blob_read" })).toBeNull();
  });
});

describe("sha8Of", () => {
  it("names which document without naming the document", () => {
    expect(sha8Of("deadbeef-Blood Panel March 2026.pdf")).toBe("deadbeef");
  });

  it("yields nothing at all for a key outside the convention, so no filename can leak", () => {
    for (const key of ["Blood Panel.pdf", "report.pdf", "DEADBEEF-x.pdf", "deadbee-x.pdf"]) {
      expect(sha8Of(key)).toBe("");
    }
  });
});
