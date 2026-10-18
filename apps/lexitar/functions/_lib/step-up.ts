// W73 (SECURITY.md gap 5) — proving the person adding a login method is the account owner, not
// somebody holding their cookie.
//
// THE HOLE THIS CLOSES. Replacing a password already required proving the current one
// (`account/methods.ts`, W71). Adding a *passkey* or a *Google identity* required only
// `requireSession`. That asymmetry is the whole attack: a session cookie lasts 30 days, but a
// credential minted with it lasts forever, so an attacker who captures a cookie once converts it into
// permanent access — and the owner is never told, because until W73 nothing notified them.
//
// WHAT IT CANNOT DO, STATED PLAINLY. Step-up needs an existing secret to challenge. An account whose
// only login method is Google has no password to prove and no passkey to assert, so there is nothing
// to demand; a passkey-only account cannot receive a second passkey at all (`getCredential` already
// 409s), which closes that case by accident rather than by design. So the rule is:
//
//   - password on file  → prove it. Enforced here.
//   - no password       → cannot be challenged. Allowed, and ALWAYS notified by email.
//
// The notification is the residual control, not a courtesy. It is the difference between "an attacker
// can do this silently" and "an attacker can do this and the owner finds out". That residual belongs in
// SECURITY.md rather than in a comment nobody reads, and it is why `sendMethodAddedNotice` fires on
// every path, including the ones that passed the challenge.

import type { D1Database } from "./identity-types";
import { getCredential } from "./identity-credentials";
import { sha256Base64Url, timingSafeEqualStr } from "./verifier";

// ---------------------------------------------------------------------------------------------------
// FRESHNESS, which is the other way to prove the person behind the cookie, and the only one that works
// on every account here.
//
// `stepUpForMethodChange` above can only challenge a PASSWORD, and says so. The account this estate
// actually needs to protect signs in with Google and a passkey and has no password, so a password
// challenge on it returns `{ok: true, challenged: false}` — it allows the request and proves nothing.
// For a route that converts read access into account control, that is not a gate.
//
// Requiring a session minted within the last few minutes is. A captured 30-day cookie cannot be made
// fresh: minting one needs the password, the passkey or the Google identity, whichever the account
// actually has. So this holds for every login method, including the two a password challenge cannot
// reach, and it needs nothing new from the browser — the client already handles a 401 by sending the
// person back to sign in.

/** Five minutes: long enough to sign in and press the button, short enough that a stolen cookie is stale. */
export const FRESH_SESSION_SECONDS = 300;

export interface FreshSessionResult {
  ok: boolean;
  /** How old the cookie was, recorded in the audit row so "how fresh was fresh" is answerable later. */
  ageSeconds: number;
}

/** `iat` is seconds since the epoch, as `signValue` writes it. */
export function requireFreshSession(iat: number, now: Date = new Date()): FreshSessionResult {
  const ageSeconds = Math.floor(now.getTime() / 1000) - iat;
  // A negative age is a clock skew between the signer and this isolate, not a fresh session: clamping
  // to 0 would let a cookie dated in the future pass forever.
  return { ok: ageSeconds >= 0 && ageSeconds <= FRESH_SESSION_SECONDS, ageSeconds };
}

export type StepUpResult =
  | { ok: true; challenged: boolean }
  | { ok: false; status: 401; errorCode: "step_up_required" | "step_up_failed"; message: string };

/**
 * Challenges the caller with their current password when there is one.
 *
 * `challenged` says whether a secret was actually proven, so a caller can log the two cases apart —
 * "verified" and "could not be verified, notified instead" are different security events and a single
 * 200 hides that.
 */
export async function stepUpForMethodChange(
  db: D1Database,
  accountId: string,
  currentAuthHash: unknown,
): Promise<StepUpResult> {
  const existing = await getCredential(db, accountId, "password");
  if (!existing) return { ok: true, challenged: false };

  const kdf = existing.kdfParams as { authHashSha256?: string };
  // A pre-P8b credential has no verifier. Refusing is the safe reading: it means we cannot check, and
  // "cannot check" must never resolve to "allowed" on the path that mints permanent access.
  if (!kdf.authHashSha256) {
    return { ok: false, status: 401, errorCode: "step_up_required", message: "set a new password before adding another sign-in method" };
  }
  if (typeof currentAuthHash !== "string" || !currentAuthHash) {
    return { ok: false, status: 401, errorCode: "step_up_required", message: "enter your current password to add a sign-in method" };
  }
  if (!timingSafeEqualStr(await sha256Base64Url(currentAuthHash), kdf.authHashSha256)) {
    return { ok: false, status: 401, errorCode: "step_up_failed", message: "that is not your current password" };
  }
  return { ok: true, challenged: true };
}
