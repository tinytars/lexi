import type { D1Database } from "../../../../_lib/identity-types";
import { createAccount } from "../../../../_lib/identity-accounts";
import { addIdentity, putCredential, putPublicKey } from "../../../../_lib/identity-credentials";
import { createVault, putEnvelope } from "../../../../_lib/identity-vault";
import { emitLifecycleEvent } from "../../../../_lib/lifecycle";
import { storeKey } from "../../../../_lib/store";
import { logRequest } from "../../../../_lib/log";
import { signSession, sessionSetCookie } from "../../../../_lib/session";
import {
  verifyRegistrationResponse,
  readChallengeCookie,
  clearChallengeCookie,
  bytesToBase64Url,
  type WebauthnEnv,
} from "../../../../_lib/webauthn";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { EmailEnv } from "../../../../_lib/email";
import { sendVerificationEmail } from "../../../../_lib/email";
import { ORG_ACCOUNT_ID } from "../../../../_lib/org";
import { sha256Base64Url } from "../../../../_lib/verifier";

// W44 P3 — passkey registration, step 2. The browser has already done all the crypto
// (attestation, keypair, PRF-derived-KEK-wrapped private key, DEK-encrypted vault blob, owner
// envelope); this route verifies the attestation against the challenge cookie and persists
// the wrapped/opaque outputs. It never sees a PRF secret, a KEK, or a DEK.
interface Env extends WebauthnEnv, EmailEnv {
  DB: D1Database;
  VAULT: { put(key: string, value: Uint8Array): Promise<unknown> };
  STORE_PREFIX: string;
}

interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

interface VerifyBody {
  attestationResponse: RegistrationResponseJSON;
  publicKeyJwk: unknown;
  wrappedPrivateKey: string; // base64
  vaultBlob: string; // base64
  ownerEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: unknown };
  orgEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: unknown };
  recovery?: { wrappedPrivateKey: string; kdfParams: unknown; authHash?: string };
  prfSaltHex: string;
}

const ROUTE = "/api/auth/passkey/register/verify";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}


function jsonResponse(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

function missingField(body: Partial<VerifyBody>): boolean {
  return (
    !body.attestationResponse ||
    !body.publicKeyJwk ||
    !body.wrappedPrivateKey ||
    !body.vaultBlob ||
    !body.ownerEnvelope ||
    !body.ownerEnvelope.wrappedDEK ||
    !body.ownerEnvelope.ephemeralPublicKeyJwk ||
    !body.orgEnvelope ||
    !body.orgEnvelope.wrappedDEK ||
    !body.orgEnvelope.ephemeralPublicKeyJwk ||
    !body.prfSaltHex
  );
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  try {
    const body = (await request.json()) as Partial<VerifyBody>;
    if (missingField(body)) {
      log(400, "missing_fields");
      return jsonResponse(400, { error: "missing required fields" });
    }
    const b = body as VerifyBody;

    const challenge = await readChallengeCookie(env, request);
    if (!challenge) {
      log(400, "bad_challenge");
      return jsonResponse(400, { error: "missing or expired challenge" });
    }

    const verification = await verifyRegistrationResponse(env, b.attestationResponse, challenge.challenge);
    if (!verification.verified || !verification.registrationInfo) {
      log(400, "verification_failed");
      return jsonResponse(400, { error: "passkey registration could not be verified" });
    }

    const { credential } = verification.registrationInfo;
    const accountId = crypto.randomUUID();
    const vaultId = crypto.randomUUID();
    const r2Key = `data-${vaultId}.enc`;

    await createAccount(env.DB, {
      id: accountId,
      displayName: challenge.displayName ?? challenge.email,
      email: challenge.email,
      lifecycleStage: "active",
    });
    await addIdentity(env.DB, { accountId, method: "passkey", credentialId: credential.id });
    await putCredential(env.DB, {
      accountId,
      method: "passkey",
      wrappedPrivateKey: base64ToBytes(b.wrappedPrivateKey),
      kdfParams: {
        prfSalt: b.prfSaltHex,
        credentialID: credential.id,
        credentialPublicKey: bytesToBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
      },
    });
    if (b.recovery) {
      const recKdf = b.recovery.kdfParams as Record<string, unknown>;
      await putCredential(env.DB, {
        accountId,
        method: "recovery",
        wrappedPrivateKey: base64ToBytes(b.recovery.wrappedPrivateKey),
        // W44 P8b — store SHA-256(recovery authHash) so the code is server-verifiable at recover time.
        kdfParams: b.recovery.authHash ? { ...recKdf, authHashSha256: await sha256Base64Url(b.recovery.authHash) } : recKdf,
      });
    }
    await putPublicKey(env.DB, { accountId, publicKeyJwk: b.publicKeyJwk });
    await createVault(env.DB, { vaultId, ownerAccountId: accountId, r2Key, hd1Version: 2 });
    await putEnvelope(env.DB, {
      vaultId,
      principalAccountId: accountId,
      wrappedDek: base64ToBytes(b.ownerEnvelope.wrappedDEK),
      ephemeralPublicKeyJwk: b.ownerEnvelope.ephemeralPublicKeyJwk,
      createdBy: accountId,
    });
    await putEnvelope(env.DB, {
      vaultId,
      principalAccountId: ORG_ACCOUNT_ID,
      wrappedDek: base64ToBytes(b.orgEnvelope.wrappedDEK),
      ephemeralPublicKeyJwk: b.orgEnvelope.ephemeralPublicKeyJwk,
      createdBy: accountId,
    });
    await env.VAULT.put(storeKey(env, r2Key), base64ToBytes(b.vaultBlob));
    await emitLifecycleEvent(env.DB, accountId, "signup");

    // W47 — fire-and-forget the verification email; delivery never blocks signup (non-blocking flow).
    if (challenge.email) {
      const origin = new URL(request.url).origin;
      const verify = sendVerificationEmail(env, { to: challenge.email, accountId, origin }).catch((e) =>
        console.log(`[email] passkey signup verification send failed: ${(e as Error).message}`),
      );
      if (context.waitUntil) context.waitUntil(verify);
    }

    const token = await signSession(env, accountId);
    log(200);
    return jsonResponse(200, { accountId, vaultId }, [sessionSetCookie(token), clearChallengeCookie()]);
  } catch {
    log(500, "register_verify_failed");
    return jsonResponse(500, { error: "registration verify failed" });
  }
}
