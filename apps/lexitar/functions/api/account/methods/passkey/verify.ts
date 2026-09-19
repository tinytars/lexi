import type { D1Database } from "../../../../_lib/identity-types";
import { addIdentity, getCredential, putCredential } from "../../../../_lib/identity-credentials";
import { requireSession } from "../../../../_lib/session";
import { logRequest } from "../../../../_lib/log";
import { stepUpForMethodChange } from "../../../../_lib/step-up";
import { notifyMethodAdded } from "../../../../_lib/notify-method";
import {
  verifyRegistrationResponse,
  readChallengeCookie,
  clearChallengeCookie,
  bytesToBase64Url,
  type WebauthnEnv,
} from "../../../../_lib/webauthn";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { jsonWithCookies } from "../../../../_lib/http";

// W44 P8 — add-a-passkey, step 2 (session-gated). Verifies the attestation and ATTACHES the passkey to
// the existing account: the browser wrapped the account's existing private key under the new passkey's
// PRF-KEK, so we only write the passkey credential + identity (no new account/vault/envelope). Never
// sees a PRF secret or KEK.
interface Env extends WebauthnEnv {
  DB: D1Database;
}
interface Ctx {
  request: Request;
  env: Env;
  // Pages provides it; these routes just never declared it. W73 needs it to send the
  // method-added notice without blocking the response on Gmail.
  waitUntil?: (p: Promise<unknown>) => void;
}
interface VerifyBody {
  attestationResponse: RegistrationResponseJSON;
  wrappedPrivateKey: string; // base64 — the account key re-wrapped under the new passkey's PRF-KEK
  prfSaltHex: string;
}

const ROUTE = "/api/account/methods/passkey/verify";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const body = (await request.json().catch(() => null)) as Partial<VerifyBody> | null;
  if (!body?.attestationResponse || !body.wrappedPrivateKey || !body.prfSaltHex) {
    log(400, "missing_fields");
    return jsonWithCookies(400, { error: "missing required fields" });
  }
  if (await getCredential(env.DB, session.accountId, "passkey")) { log(409, "passkey_exists"); return jsonWithCookies(409, { error: "a passkey is already set" }); }

  // W73 gap 5 — a session cookie alone used to be enough to mint a passkey, and a passkey outlives the
  // cookie that created it. Challenge the current password when there is one; when there is not, the
  // notice below is the only control available and it always fires. See _lib/step-up.ts.
  const stepUp = await stepUpForMethodChange(env.DB, session.accountId, (body as { currentAuthHash?: unknown }).currentAuthHash);
  if (!stepUp.ok) { log(stepUp.status, stepUp.errorCode); return jsonWithCookies(stepUp.status, { error: stepUp.message, errorCode: stepUp.errorCode }); }

  const challenge = await readChallengeCookie(env, request);
  if (!challenge) { log(400, "bad_challenge"); return jsonWithCookies(400, { error: "missing or expired challenge" }); }

  const verification = await verifyRegistrationResponse(env, body.attestationResponse, challenge.challenge);
  if (!verification.verified || !verification.registrationInfo) {
    log(400, "verification_failed");
    return jsonWithCookies(400, { error: "passkey registration could not be verified" });
  }

  const { credential } = verification.registrationInfo;
  await addIdentity(env.DB, { accountId: session.accountId, method: "passkey", credentialId: credential.id });
  await putCredential(env.DB, {
    accountId: session.accountId,
    method: "passkey",
    wrappedPrivateKey: base64ToBytes(body.wrappedPrivateKey),
    kdfParams: {
      prfSalt: body.prfSaltHex,
      credentialID: credential.id,
      credentialPublicKey: bytesToBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
    },
  });

  await notifyMethodAdded(context, env, session.accountId, "passkey");

  log(200);
  return jsonWithCookies(200, { ok: true, method: "passkey" }, [clearChallengeCookie()]);
}
