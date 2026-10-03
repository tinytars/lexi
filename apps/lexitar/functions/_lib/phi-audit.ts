// Every read of someone else's record leaves a row on THAT person's access screen.
//
// DPGA 9A.4 used to only *state* this gap: `/api/vault/{id}`, `/api/raw/…`, `/api/document-extract`
// and `/api/providers/patients` all decided access correctly and then wrote nothing down, so a
// patient had no way to learn that a clinician, a support agent or an operator had opened their
// record. `/api/support/access` was the single exception. This module is the one place the rule
// lives, so the owner exclusion below cannot be implemented differently in seven routes.
//
// WHY THE OWNER IS EXCLUDED. A single record view is tens of reads — the vault blob at unlock and on
// every keyring refresh, two listings per client selection, one object per attachment rendered.
// Logging those would bury the third-party reads under the owner's own clicks and turn a disclosure
// log into a traffic log, on a screen (`functions/api/account/access-events.ts`) that shows the
// newest 200 rows. A disclosure is a read by someone who is not the subject; nothing else.
//
// WHY THIS IS AWAITED AND FAILS CLOSED.
// `tests/unit/org-key-chokepoint.test.ts` states the house rule: the row is recorded before the key
// exists, and an identifier that could not be audited never reaches the crypto. So a failed insert
// refuses the read (503) rather than serving an unrecorded one. That is only safe BECAUSE of the
// owner exclusion — an owner read never reaches the insert, so a database blip cannot lock a patient
// out of their own record; it can only stop third-party reads. Sign-in makes the opposite trade for
// the opposite reason: there, refusing is itself the harm.

import type { D1Database } from "./identity-types";
import { insertAccessEvent } from "./identity-audit";
import { json } from "./http";

/**
 * The complete vocabulary of privileged-access actions this app writes, frozen.
 *
 * `functions/_lib/erasure.ts` deliberately does NOT delete `phi_access_events` rows — they outlive
 * account erasure and stay on patients' screens — so a rename leaves two names for one event in the
 * historical record with no way to reconcile them. `tests/unit/audit-chokepoint.test.ts` pins the set.
 * Convention: `<object>_<verb-past-tense>`, following the pre-existing `support_access_*` family.
 */
export const PHI_ACCESS_ACTIONS = [
  "vault_blob_read",
  "vault_blob_read_ops",
  "vault_blob_written",
  "raw_object_read",
  "raw_namespace_listed",
  "document_text_read",
  "provider_roster_viewed",
  "provider_access_revoked",
] as const;

export type PhiAccessAction = (typeof PHI_ACCESS_ACTIONS)[number];

/** The log line every route logs when `auditPrivilegedRead` refuses; the body itself lives below. */
export const AUDIT_UNAVAILABLE = "audit_unavailable";

export interface PrivilegedRead {
  /** Who is asking. */
  actor: string;
  /** Whose record it is — the person the row appears for. Never the caller unless they are the same. */
  subject: string;
  vaultId?: string | null;
  action: PhiAccessAction;
  /** The `provider_links.consent_ref` this read is exercising, where the route has one in hand. */
  consentRef?: string | null;
  /** Shape only, never content: a content-address prefix or a count. No filename, no PHI. */
  meta?: Record<string, unknown>;
}

/**
 * Records one privileged read. Returns null when the read may proceed — including when there was
 * nothing to record because the caller is the subject — and the 503 to return when the row could not
 * be written. Callers log that refusal with their own route logger.
 */
export async function auditPrivilegedRead(db: D1Database, e: PrivilegedRead): Promise<Response | null> {
  if (e.actor === e.subject) return null;
  try {
    await insertAccessEvent(db, {
      actorAccountId: e.actor,
      subjectAccountId: e.subject,
      vaultId: e.vaultId ?? null,
      action: e.action,
      consentRef: e.consentRef ?? null,
      meta: e.meta ?? {},
    });
  } catch {
    // Swallowed rather than rethrown: _middleware.ts's catch-all would file a 500 as an application
    // bug, and this is a refusal with a name the client can act on.
    return json(503, { error: "access log unavailable", errorCode: AUDIT_UNAVAILABLE });
  }
  return null;
}

/**
 * The content-address prefix of a raw key (`<sha8>-<name>`), which says WHICH document was disclosed
 * without naming it. The pattern is deliberately strict: anything that is not a hex prefix yields the
 * empty string, so a key written outside the content-addressing convention cannot smuggle a filename
 * into `meta` (migration 0003's header promises `phi_access_events` holds no PHI).
 */
export const sha8Of = (file: string): string => /^([0-9a-f]{8})-/.exec(file)?.[1] ?? "";
