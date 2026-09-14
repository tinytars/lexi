import type { D1Database } from "../../../../_lib/identity-types";
import { getAccount } from "../../../../_lib/identity-accounts";
import { getCredential } from "../../../../_lib/identity-credentials";
import { requireSession } from "../../../../_lib/session";
import { logRequest } from "../../../../_lib/log";
import { generateRegistrationOptions, setChallengeCookie, bytesToHex, type WebauthnEnv } from "../../../../_lib/webauthn";

// W44 P8 — add-a-passkey, step 1 (session-gated). Mints WebAuthn creation options + PRF salt for the
// LOGGED-IN account (no email-exists check — the account already exists). One passkey per account
// (credentials is keyed by method), so refuse if one is already set.
interface Env extends WebauthnEnv {
  DB: D1Database;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/account/methods/passkey/options";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const account = await getAccount(env.DB, session.accountId);
  if (!account) { log(404, "no_account"); return json(404, { error: "account not found" }); }
  if (await getCredential(env.DB, session.accountId, "passkey")) { log(409, "passkey_exists"); return json(409, { error: "a passkey is already set" }); }

  const prfSalt = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const userName = account.email ?? account.displayName;
  const options = await generateRegistrationOptions(env, { email: userName, displayName: account.displayName, prfSalt });
  const cookie = await setChallengeCookie(env, { challenge: options.challenge, email: userName, displayName: account.displayName, prfSalt: bytesToHex(prfSalt) });

  log(200);
  return json(200, options, { "set-cookie": cookie });
}
