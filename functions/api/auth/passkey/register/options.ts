import type { D1Database } from "../../../../_lib/identity-types";
import { getAccountByEmail } from "../../../../_lib/identity-accounts";
import { logRequest } from "../../../../_lib/log";
import { generateRegistrationOptions, setChallengeCookie, bytesToHex, type WebauthnEnv } from "../../../../_lib/webauthn";

// W44 P3 — passkey registration, step 1: mint WebAuthn creation options (with the PRF
// extension requested) and stash the challenge + a fresh per-credential PRF salt in a
// short-lived signed cookie for register/verify.ts to check.
interface Env extends WebauthnEnv {
  DB: D1Database;
}

interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/passkey/register/options";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  try {
    const body = (await request.json()) as Partial<{ email: string; displayName: string }>;
    if (!body.email || !body.displayName) {
      log(400, "missing_fields");
      return json(400, { error: "missing required fields" });
    }

    if (await getAccountByEmail(env.DB, body.email)) {
      log(409, "email_exists");
      return json(409, { error: "email exists" });
    }

    const prfSalt = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const options = await generateRegistrationOptions(env, { email: body.email, displayName: body.displayName, prfSalt });

    const cookie = await setChallengeCookie(env, {
      challenge: options.challenge,
      email: body.email,
      displayName: body.displayName,
      prfSalt: bytesToHex(prfSalt),
    });

    log(200);
    return json(200, options, { "set-cookie": cookie });
  } catch {
    log(500, "register_options_failed");
    return json(500, { error: "failed to build registration options" });
  }
}
