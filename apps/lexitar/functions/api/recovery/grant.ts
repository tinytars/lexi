// W73 — POST /api/recovery/grant: a clinician issues a one-time recovery code for a patient.
//
// The clinician's browser has already done the only interesting part: it unwrapped the patient's DEK
// with its OWN key — which it could do before this feature existed, because that is what provider
// access is — and re-wrapped it under PBKDF2 of a code it generated. This route stores the result and
// records who issued it.
//
// So this grants the clinician nothing new. What it does grant, and what SECURITY.md records under
// Deliberate non-goals, is the ability to turn read access into ACCOUNT CONTROL: whoever holds the code
// can replace the account's keypair. That is a real escalation and the reason for the capability check,
// the live-link check, and the audit row.
//
// THE IDENTITY CHECK IS THE PHONE CALL, and it is structural rather than policy: the code reaches the
// patient only by the clinician reading it to them, so there is no "approve" button that works without
// that conversation happening.
//
// There is deliberately no emailed-delivery option. For the server to put the code in an email it must
// be given the code, and it already holds `wrapped_dek` — anything holding both can open the record. An
// emailed code would therefore make the operator transiently able to read a patient's record, which is
// SECURITY.md's central claim rather than a secondary invariant. Decided 2026-08-25; see RECOVERY.md.

import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { listPatientsForProvider } from "../../_lib/identity-providers";
import { insertAccessEvent } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { can, roleOf } from "../../_lib/capabilities";
import { issueGrant } from "../../_lib/recovery";
import type { EmailEnv } from "../../_lib/email";
import { logRequest } from "../../_lib/log";

type Env = EmailEnv & { DB: D1Database; SESSION_SECRET: string };
interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

const ROUTE = "/api/recovery/grant";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const me = await getAccount(env.DB, session.accountId);
  if (!can(roleOf(me), "recovery:issue")) {
    // Support is deliberately excluded. A support agent can already open a granted vault through the
    // audited path; letting them also mint account control would make support a superuser.
    log(403, "not_permitted");
    return json(403, { error: "not permitted", errorCode: "not_permitted" });
  }

  let body: { ownerAccountId?: unknown; wrappedDek?: unknown; kdfParams?: unknown; codeAuthHash?: unknown };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }
  const { ownerAccountId, wrappedDek, codeAuthHash } = body;
  const kdfParams = body.kdfParams as { salt?: unknown; iterations?: unknown } | undefined;
  if (
    typeof ownerAccountId !== "string" || typeof wrappedDek !== "string" || typeof codeAuthHash !== "string" ||
    typeof kdfParams?.salt !== "string" || typeof kdfParams?.iterations !== "number"
  ) {
    log(400, "bad_body");
    return json(400, { error: "ownerAccountId, wrappedDek, kdfParams and codeAuthHash are required" });
  }

  // The link must be LIVE right now, not merely have existed. A clinician's browser can produce a
  // valid wrapped DEK from a cached key long after their grant lapsed, so the server re-checks rather
  // than trusting that the caller could only have got here legitimately.
  const link = (await listPatientsForProvider(env.DB, session.accountId)).find(
    (l) => l.ownerAccountId === ownerAccountId && l.role === "primary" && l.status === "active" &&
      (!l.expiresAt || new Date(l.expiresAt).getTime() > Date.now()),
  );
  if (!link) { log(403, "no_live_grant"); return json(403, { error: "no active clinician link with this patient", errorCode: "no_live_grant" }); }

  const patient = await getAccount(env.DB, ownerAccountId);
  if (!patient || patient.deletedAt) { log(404, "no_patient"); return json(404, { error: "no such patient" }); }

  const grant = await issueGrant(env.DB, {
    accountId: ownerAccountId,
    issuedBy: session.accountId,
    wrappedDek: base64ToBytes(wrappedDek),
    kdfParams: { salt: kdfParams.salt, iterations: kdfParams.iterations },
    codeAuthHash,
  });

  await insertAccessEvent(env.DB, {
    actorAccountId: session.accountId,
    subjectAccountId: ownerAccountId,
    action: "recovery.grant_issued",
    consentRef: grant.id,
  });

  log(200);
  return json(200, { grantId: grant.id, expiresAt: grant.expiresAt });
}
