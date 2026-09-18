import { requireSession, verifyValue, parseCookie } from "../../../_lib/session";
import { logRequest } from "../../../_lib/log";
import { stepUpForMethodChange } from "../../../_lib/step-up";
import { notifyMethodAdded } from "../../../_lib/notify-method";
import { linkGoogleToAccount } from "../../../_lib/google";
import type { D1Database } from "../../../_lib/identity-types";
import { getAccount, getAccountByEmail, setEmailConfirmed, updateAccountProfile } from "../../../_lib/identity-accounts";
import { json } from "../../../_lib/http";

// W45 §J — finish "add Google to my account". The OAuth popup (callback.ts, mode=link) verified the
// Google identity and set a signed hd_google_link cookie binding the verified `sub` to THIS account.
// The client posts its in-memory private key; the server wraps it under the server KEK and writes the
// google credential + identity. The `sub` is read from the SIGNED COOKIE, never the request body, so
// a caller can't graft an arbitrary Google identity onto their account.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  GOOGLE_KEK: string;
}
interface Ctx {
  request: Request;
  env: Env;
  // Pages provides it; these routes just never declared it. W73 needs it to send the
  // method-added notice without blocking the response on Gmail.
  waitUntil?: (p: Promise<unknown>) => void;
}

const ROUTE = "/api/account/methods/google";
const LINK_COOKIE = "hd_google_link";
const clearLink = `${LINK_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const link = await verifyValue<{ accountId: string; sub: string; email: string | null; emailVerified?: boolean }>(
    env.SESSION_SECRET,
    parseCookie(request.headers.get("cookie"), LINK_COOKIE),
  );
  if (!link || link.accountId !== session.accountId) {
    log(400, "no_link_cookie");
    return json(400, { error: "no pending Google link — start from Connect Google" });
  }

  let body: { privateKeyPkcs8?: unknown; currentAuthHash?: unknown };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }
  if (typeof body.privateKeyPkcs8 !== "string") { log(400, "bad_body"); return json(400, { error: "privateKeyPkcs8 required" }); }

  // W73 gap 5 — the Google link cookie proves control of a Google account, not of THIS account; the
  // only thing tying the two together was a session cookie. Challenge the current password when there
  // is one. See _lib/step-up.ts for why an account without one can only be notified.
  const stepUp = await stepUpForMethodChange(env.DB, session.accountId, body.currentAuthHash);
  if (!stepUp.ok) { log(stepUp.status, stepUp.errorCode); return json(stepUp.status, { error: stepUp.message, errorCode: stepUp.errorCode }); }

  try {
    await linkGoogleToAccount(env.DB, session.accountId, link.sub, body.privateKeyPkcs8, env.GOOGLE_KEK);
    // W50 — Google has verified this address, so treat it as the account's email. Adopt it over an
    // empty/unverified email (and confirm); leave an already-verified email untouched. Same trust in
    // Google's email_verified claim that JIT signup already uses (google.ts provisionGoogleAccount).
    if (link.email && link.emailVerified) {
      const acct = await getAccount(env.DB, session.accountId);
      // Don't adopt an email another account already owns — accounts.email is UNIQUE, so overwriting
      // would violate the constraint. In that case just link Google and leave this account's email as-is.
      const owner = await getAccountByEmail(env.DB, link.email);
      if (acct && !acct.emailConfirmed && (!owner || owner.id === session.accountId)) {
        await updateAccountProfile(env.DB, session.accountId, { email: link.email });
        await setEmailConfirmed(env.DB, session.accountId, true);
      }
    }
    await notifyMethodAdded(context, env, session.accountId, "Google");
    log(200);
    return json(200, { ok: true, method: "google" }, { "set-cookie": clearLink });
  } catch (e) {
    log(409, "link_failed");
    return json(409, { error: (e as Error).message }, { "set-cookie": clearLink });
  }
}
