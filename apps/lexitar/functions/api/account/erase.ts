// W72 — POST /api/account/erase: the caller deletes their own account and everything under it.
//
// POST, not DELETE, and on its own path rather than as a verb on /api/account. Two reasons: DELETE on
// a resource invites a client library to retry it, and this operation is irreversible; and it takes a
// body, which several HTTP clients and intermediaries will drop from a DELETE.
//
// SELF ONLY. There is no "erase account X" parameter, and adding one would be a different feature with
// a different threat model — an administrative erasure needs an approval trail, not a session cookie.
// The capability check is nominally redundant with "the caller is the subject", and it is there anyway
// so the policy table stays the single place anyone has to read to know who can do this.
//
// CONFIRMATION, AND WHY IT IS NOT AUTHENTICATION: the body must echo the account's own email address.
// That defends against a mis-clicked or CSRF-shaped request, and it does not defend against a stolen
// session cookie — a thief who has the cookie can read the email from /api/account.
//
// A real step-up ceremony would. One exists for replacing a password (`methods.ts`'s
// `step_up_required`, which verifies the CURRENT authHash) and it is not reusable here: it only works
// for an account that has a password, and erasure must be available to a passkey-only or Google-only
// account too. Generalising it is SECURITY.md gap 6, which covers adding a login method as well, and
// is deliberately not invented for one endpoint. Stated plainly rather than implied, because a
// confirmation prompt is very easy to mistake for a security control.

import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { requireSession } from "../../_lib/session";
import { can, roleOf } from "../../_lib/capabilities";
import { eraseAccount, type R2Like } from "../../_lib/erasure";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";

interface Env {
  DB: D1Database;
  VAULT: R2Like;
  SESSION_SECRET: string;
  STORE_PREFIX: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/account/erase";

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }
  const me = await getAccount(env.DB, session.accountId);
  // A signed session whose account row is gone (already erased, or erased in a concurrent request) is
  // not an authorization to hard-delete anything. Checked here so the confirmation below can read
  // `me.email` without asserting a null away on the way into an irreversible operation.
  if (!me) {
    log(401, "unauthorized");
    return json(401, { error: "unauthorized", errorCode: "unauthorized" });
  }
  if (!can(roleOf(me), "account:erase-self")) {
    log(403, "not_permitted");
    return json(403, { error: "not permitted", errorCode: "not_permitted" });
  }

  let body: { confirmEmail?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON", errorCode: "bad_json" });
  }
  // An account with no email cannot satisfy the confirmation, and is refused rather than waved
  // through — "there is nothing to type, so type nothing" would make the guard vanish exactly for the
  // accounts it is least able to identify.
  const confirm = typeof body.confirmEmail === "string" ? body.confirmEmail.trim().toLowerCase() : "";
  if (!me.email || confirm !== me.email.trim().toLowerCase()) {
    log(400, "confirmation_mismatch");
    return json(400, {
      error: "type your account email exactly to confirm erasure",
      errorCode: "confirmation_mismatch",
    });
  }

  const report = await eraseAccount(env, session.accountId);
  // The report is returned in full, including a non-zero `unattributable`. A subject who asked for
  // their data to be deleted is entitled to know that some of it could not be, and burying that in a
  // server log would make this endpoint's answer a lie by omission.
  log(200, report.complete ? undefined : "erasure_incomplete");
  return json(200, report);
}
