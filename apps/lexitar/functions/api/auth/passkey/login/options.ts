import type { D1Database } from "../../../../_lib/identity-types";
import { getAccountByEmail } from "../../../../_lib/identity-accounts";
import { getCredential } from "../../../../_lib/identity-credentials";
import { logRequest } from "../../../../_lib/log";
import {
  generateAuthenticationOptions,
  setChallengeCookie,
  hexToBytes,
  type WebauthnEnv,
} from "../../../../_lib/webauthn";
import type { AuthenticatorTransport } from "@simplewebauthn/server";

// W44 P3 — passkey login, step 1: look up the account's stored passkey credential and mint
// WebAuthn request options (with the PRF extension, using the SAME prfSalt stored at
// registration so the authenticator reproduces the same PRF secret → KEK).
interface Env extends WebauthnEnv {
  DB: D1Database;
}

interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/passkey/login/options";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  try {
    const body = (await request.json()) as Partial<{ email: string }>;
    if (!body.email) {
      log(400, "missing_fields");
      return json(400, { error: "missing required fields" });
    }

    const account = await getAccountByEmail(env.DB, body.email);
    const cred = account ? await getCredential(env.DB, account.id, "passkey") : null;
    if (!cred) {
      log(404, "no_passkey");
      return json(404, { error: "no passkey registered for this account" });
    }

    const kdf = cred.kdfParams as { prfSalt: string; credentialID: string; transports?: AuthenticatorTransport[] };
    const options = await generateAuthenticationOptions(env, {
      credentialId: kdf.credentialID,
      transports: kdf.transports,
      prfSalt: hexToBytes(kdf.prfSalt),
    });

    const cookie = await setChallengeCookie(env, { challenge: options.challenge, email: body.email, prfSalt: kdf.prfSalt });

    log(200);
    return json(200, options, { "set-cookie": cookie });
  } catch {
    log(500, "login_options_failed");
    return json(500, { error: "failed to build authentication options" });
  }
}
