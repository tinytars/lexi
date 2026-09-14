import type { D1Database } from "../../../../_lib/identity-types";
import { getCredential, getIdentityByCredentialId, updatePasskeyCounter } from "../../../../_lib/identity-credentials";
import { getEnvelope, listVaultsForOwner } from "../../../../_lib/identity-vault";
import { logRequest } from "../../../../_lib/log";
import { signSession, sessionSetCookie } from "../../../../_lib/session";
import {
  verifyAuthenticationResponse,
  readChallengeCookie,
  clearChallengeCookie,
  base64UrlToBytes,
  type WebauthnEnv,
} from "../../../../_lib/webauthn";
import type { AuthenticationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";

// W44 P3 — passkey login, step 2. Verifies the assertion against the challenge cookie and the
// stored credential, bumps the replay-detection counter, then hands back the wrapped private
// key + owner envelope; the client re-derives the PRF secret → KEK and unwraps locally. The
// server never sees the PRF secret, the KEK, or the DEK.
interface Env extends WebauthnEnv {
  DB: D1Database;
}

interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/auth/passkey/login/verify";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function jsonResponse(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  try {
    const body = (await request.json()) as Partial<{ authenticationResponse: AuthenticationResponseJSON }>;
    if (!body.authenticationResponse) {
      log(400, "missing_fields");
      return jsonResponse(400, { error: "missing required fields" });
    }

    const challenge = await readChallengeCookie(env, request);
    if (!challenge) {
      log(400, "bad_challenge");
      return jsonResponse(400, { error: "missing or expired challenge" });
    }

    const identity = await getIdentityByCredentialId(env.DB, body.authenticationResponse.id);
    const cred = identity ? await getCredential(env.DB, identity.accountId, "passkey") : null;
    if (!identity || !cred) {
      log(401, "unknown_credential");
      return jsonResponse(401, { error: "unknown credential" });
    }

    const kdf = cred.kdfParams as {
      prfSalt: string;
      credentialID: string;
      credentialPublicKey: string;
      counter: number;
      transports?: WebAuthnCredential["transports"];
    };
    const credential: WebAuthnCredential = {
      id: kdf.credentialID,
      // Re-wrap in a fresh Uint8Array: base64UrlToBytes's buffer types as ArrayBufferLike, but
      // WebAuthnCredential.publicKey wants the narrower Uint8Array<ArrayBuffer>.
      publicKey: new Uint8Array(base64UrlToBytes(kdf.credentialPublicKey)),
      counter: kdf.counter,
      transports: kdf.transports,
    };

    const verification = await verifyAuthenticationResponse(env, body.authenticationResponse, challenge.challenge, credential);
    if (!verification.verified) {
      log(401, "verification_failed");
      return jsonResponse(401, { error: "passkey authentication could not be verified" });
    }

    await updatePasskeyCounter(env.DB, identity.accountId, verification.authenticationInfo.newCounter);

    const vault = (await listVaultsForOwner(env.DB, identity.accountId))[0] ?? null;
    const envelope = vault ? await getEnvelope(env.DB, vault.vaultId, identity.accountId) : null;

    const token = await signSession(env, identity.accountId);
    log(200);
    return jsonResponse(
      200,
      {
        accountId: identity.accountId,
        vaultId: vault?.vaultId ?? null,
        r2Key: vault?.r2Key ?? null,
        rotationPending: vault?.rotationPending ?? false,
        wrappedPrivateKey: bytesToBase64(cred.wrappedPrivateKey),
        prfSalt: kdf.prfSalt,
        ownerEnvelope: envelope
          ? { wrappedDEK: bytesToBase64(envelope.wrappedDek), ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk }
          : null,
      },
      [sessionSetCookie(token), clearChallengeCookie()]
    );
  } catch {
    log(500, "login_verify_failed");
    return jsonResponse(500, { error: "login verify failed" });
  }
}
