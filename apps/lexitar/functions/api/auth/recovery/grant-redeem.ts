// W73 — POST /api/auth/recovery/grant-redeem: the patient uses the code their clinician read to them.
//
// Unauthenticated by necessity — the whole point is that this person cannot sign in. What authorises it
// is the code, checked against a grant that a clinician created, that expires in an hour, that can be
// wrong five times, and that can be used once.
//
// TWO CALLS, because the second needs what the first returns. The client asks for the wrapped DEK,
// unwraps it in the browser, generates a NEW keypair, and comes back with the re-wrapped material. The
// code is proved on BOTH calls — the second is not authorised by the first having happened.
//
// The server never sees the code, the DEK, or the password. It stores blobs it cannot open and swaps
// them atomically.

import type { D1Database } from "../../../_lib/identity-types";
import { getAccountByEmail } from "../../../_lib/identity-accounts";
import { listVaultsForOwner } from "../../../_lib/identity-vault";
import { checkRedemption, activateRecovery, type NewIdentity } from "../../../_lib/recovery";
import { signSession, sessionSetCookie } from "../../../_lib/session";
import { sendMethodAddedNotice, type EmailEnv } from "../../../_lib/email";
import { logRequest } from "../../../_lib/log";
import { json } from "../../../_lib/http";

type Env = EmailEnv & { DB: D1Database; SESSION_SECRET: string };
interface Ctx {
  request: Request;
  env: Env;
  waitUntil?: (p: Promise<unknown>) => void;
}

const ROUTE = "/api/auth/recovery/grant-redeem";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * One message for every failure, whatever the cause.
 *
 * The caller is unauthenticated, so telling "no grant exists for this address" apart from "wrong code"
 * would reveal whether a clinician has issued a recovery for a given person — which is a fact about
 * someone's care, not just about their account. Same reasoning as `decoy-salt.ts`. The errorCode is
 * still logged server-side, where it is useful and invisible.
 */
const REJECT = { error: "that code is not valid, or it has expired", errorCode: "invalid_code" };

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  let body: {
    email?: unknown;
    codeAuthHash?: unknown;
    newIdentity?: {
      publicKeyJwk?: unknown;
      wrappedPrivateKey?: unknown;
      kdfParams?: { salt?: unknown; iterations?: unknown };
      authHash?: unknown;
      envelope?: { wrappedDEK?: unknown; ephemeralPublicKeyJwk?: unknown };
    };
  };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }
  if (typeof body.email !== "string" || typeof body.codeAuthHash !== "string") {
    log(400, "missing_fields");
    return json(400, { error: "email and codeAuthHash are required" });
  }

  const acct = await getAccountByEmail(env.DB, body.email);
  // An unknown address still costs the caller a round trip and tells them nothing. There is no grant to
  // count attempts against, which is a real (accepted) asymmetry: address enumeration through THIS route
  // is bounded by the general rate limiting that SECURITY.md gap 3 still tracks, not by anything here.
  if (!acct || acct.deletedAt) { log(401, "no_account"); return json(401, REJECT); }

  const check = await checkRedemption(env.DB, acct.id, body.codeAuthHash);
  if (!check.ok) { log(401, check.errorCode); return json(401, REJECT); }
  const { grant } = check;

  const ni = body.newIdentity;
  if (!ni) {
    // FIRST CALL: hand back the wrapped DEK so the browser can unwrap it. Nothing has changed yet, and
    // an attempt has been spent — which is deliberate, or this call would be a free oracle.
    log(200);
    return json(200, {
      wrappedDek: bytesToBase64(grant.wrappedDek!),
      kdfParams: grant.kdfParams,
    });
  }

  if (
    typeof ni.wrappedPrivateKey !== "string" || typeof ni.authHash !== "string" || !ni.publicKeyJwk ||
    typeof ni.kdfParams?.salt !== "string" || typeof ni.kdfParams?.iterations !== "number" ||
    typeof ni.envelope?.wrappedDEK !== "string" || !ni.envelope?.ephemeralPublicKeyJwk
  ) {
    // Checked BEFORE the grant is consumed: a malformed second call must not burn the patient's code.
    log(400, "bad_new_identity");
    return json(400, { error: "newIdentity must carry publicKeyJwk, wrappedPrivateKey, kdfParams, authHash and envelope" });
  }

  const identity: NewIdentity = {
    publicKeyJwk: ni.publicKeyJwk,
    wrappedPrivateKey: base64ToBytes(ni.wrappedPrivateKey),
    kdfParams: { salt: ni.kdfParams.salt, iterations: ni.kdfParams.iterations },
    authHash: ni.authHash,
    envelope: { wrappedDEK: base64ToBytes(ni.envelope.wrappedDEK), ephemeralPublicKeyJwk: ni.envelope.ephemeralPublicKeyJwk },
  };

  const { vaultId } = await activateRecovery(env.DB, acct.id, identity, grant);
  const vault = (await listVaultsForOwner(env.DB, acct.id))[0] ?? null;

  if (acct.email) {
    const notice = sendMethodAddedNotice(env, { to: acct.email, method: "password (recovery by your provider)" }).catch((e) =>
      console.log(`[email] grant-recovery notice failed: ${(e as Error).message}`),
    );
    if (context.waitUntil) context.waitUntil(notice);
    else await notice;
  }

  // Minted AFTER activateRecovery's revokeSessions, so the person who just recovered stays signed in
  // while everyone else is signed out.
  const token = await signSession(env, acct.id);
  log(200);
  return json(
    200,
    { accountId: acct.id, vaultId, r2Key: vault?.r2Key ?? null, rotationPending: true },
    { "set-cookie": sessionSetCookie(token) },
  );
}
