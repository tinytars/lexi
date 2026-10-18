import type { D1Database } from "../../../_lib/identity-types";
import { createAccount, getAccountByEmail } from "../../../_lib/identity-accounts";
import { addIdentity, putCredential, putPublicKey } from "../../../_lib/identity-credentials";
import { createVault, putEnvelope } from "../../../_lib/identity-vault";
import { emitLifecycleEvent } from "../../../_lib/lifecycle";
import { storeKey } from "../../../_lib/store";
import { logRequest } from "../../../_lib/log";
import { signSession, sessionSetCookie } from "../../../_lib/session";
import type { EmailEnv } from "../../../_lib/email";
import { sendVerificationEmail } from "../../../_lib/email";
import { ORG_ACCOUNT_ID } from "../../../_lib/org";
import { sha256Base64Url } from "../../../_lib/verifier";
import { json } from "../../../_lib/http";

// W44 P2 — password signup. The browser has already done all the crypto (keypair,
// KEK-wrapped private key, authHash, DEK-encrypted vault blob, owner envelope); this
// route only persists the wrapped/opaque outputs. It never sees a password or a DEK.
interface Env extends EmailEnv {
  DB: D1Database;
  VAULT: { put(key: string, value: Uint8Array): Promise<unknown> };
  STORE_PREFIX: string;
}

interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

interface SignupBody {
  email: string;
  displayName: string;
  publicKeyJwk: unknown;
  wrappedPrivateKey: string; // base64
  kdfParams: { salt: string; iterations: number };
  authHash: string; // base64url
  vaultBlob: string; // base64
  ownerEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: unknown };
  orgEnvelope: { wrappedDEK: string; ephemeralPublicKeyJwk: unknown };
  recovery?: { wrappedPrivateKey: string; kdfParams: { salt: string; iterations: number }; authHash?: string };
}

const ROUTE = "/api/auth/password/signup";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Server stores SHA-256(authHash), never authHash itself — a leaked DB row still can't
// be replayed to log in without re-deriving the same authHash from the password.

function missingField(body: Partial<SignupBody>): boolean {
  return (
    !body.email ||
    !body.displayName ||
    !body.publicKeyJwk ||
    !body.wrappedPrivateKey ||
    !body.kdfParams ||
    !body.authHash ||
    !body.vaultBlob ||
    !body.ownerEnvelope ||
    !body.ownerEnvelope.wrappedDEK ||
    !body.ownerEnvelope.ephemeralPublicKeyJwk ||
    !body.orgEnvelope ||
    !body.orgEnvelope.wrappedDEK ||
    !body.orgEnvelope.ephemeralPublicKeyJwk
  );
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  try {
    const body = (await request.json()) as Partial<SignupBody>;
    if (missingField(body)) {
      log(400, "missing_fields");
      return json(400, { error: "missing required fields" });
    }
    const b = body as SignupBody;

    if (await getAccountByEmail(env.DB, b.email)) {
      log(409, "email_exists");
      return json(409, { error: "email exists" });
    }

    const accountId = crypto.randomUUID();
    const vaultId = crypto.randomUUID();
    const r2Key = `data-${vaultId}.enc`;

    await createAccount(env.DB, { id: accountId, displayName: b.displayName, email: b.email, lifecycleStage: "active" });
    await addIdentity(env.DB, { accountId, method: "password" });
    await putCredential(env.DB, {
      accountId,
      method: "password",
      wrappedPrivateKey: base64ToBytes(b.wrappedPrivateKey),
      kdfParams: { ...b.kdfParams, authHashSha256: await sha256Base64Url(b.authHash) },
    });
    if (b.recovery) {
      await putCredential(env.DB, {
        accountId,
        method: "recovery",
        wrappedPrivateKey: base64ToBytes(b.recovery.wrappedPrivateKey),
        // W44 P8b — store SHA-256(recovery authHash) so the code is server-verifiable at recover time.
        kdfParams: b.recovery.authHash
          ? { ...b.recovery.kdfParams, authHashSha256: await sha256Base64Url(b.recovery.authHash) }
          : b.recovery.kdfParams,
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
    const origin = new URL(request.url).origin;
    const verify = sendVerificationEmail(env, { to: b.email, accountId, origin }).catch((e) =>
      console.log(`[email] signup verification send failed: ${(e as Error).message}`),
    );
    if (context.waitUntil) context.waitUntil(verify);
    else await verify; // fallback if the runtime doesn't expose waitUntil

    const token = await signSession(env, accountId);
    log(200);
    return json(200, { accountId, vaultId }, { "set-cookie": sessionSetCookie(token) });
  } catch {
    log(500, "signup_failed");
    return json(500, { error: "signup failed" });
  }
}
