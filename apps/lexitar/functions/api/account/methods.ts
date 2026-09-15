import type { AuthMethod, D1Database } from "../../_lib/identity-types";
import { revokeSessions } from "../../_lib/identity-accounts";
import { addIdentity, deleteCredential, deleteIdentity, getCredential, listCredentials, putCredential } from "../../_lib/identity-credentials";
import { requireSession, signSession, sessionSetCookie } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { stepUpForMethodChange } from "../../_lib/step-up";
import { sha256Base64Url } from "../../_lib/verifier";
import { notifyMethodAdded } from "../../_lib/notify-method";

// W44 P8 — manage the caller's login methods. Each method independently wraps the same account private
// key (client-side), so ADD = write another wrapped-key credential; REMOVE = delete it, guarded so it
// can never leave the account with no usable login method (recovery is NOT a login method).
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
  // Pages provides it; these routes just never declared it. W73 needs it to send the
  // method-added notice without blocking the response on Gmail.
  waitUntil?: (p: Promise<unknown>) => void;
}

const ROUTE = "/api/account/methods";
const LOGIN_METHODS: AuthMethod[] = ["password", "passkey", "google"];

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** Length-guarded constant-time compare — Workers has no crypto.timingSafeEqual (mirrors login.ts). */
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const creds = await listCredentials(env.DB, session.accountId);
  // W45 — google now carries a (server-KEK-wrapped) credential like the others, so it lists uniformly.
  const methods = creds.map((c) => ({ method: c.method, createdAt: c.createdAt, isRecovery: c.method === "recovery" }));

  log(200);
  return json(200, { methods });
}

// Add a PASSWORD method (passkey add uses the ceremony at methods/passkey/{options,verify}). The client
// wrapped its in-memory private key under a new password-KEK and computed the auth hash; we store the
// wrapped key + SHA-256(authHash) (never the password/KEK), mirroring signup.
export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  let body: { method?: unknown; wrappedPrivateKey?: unknown; kdfParams?: unknown; authHash?: unknown; currentAuthHash?: unknown };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }
  if (body.method !== "password") { log(400, "bad_method"); return json(400, { error: "only password is added here; use methods/passkey for passkeys" }); }
  if (typeof body.wrappedPrivateKey !== "string" || typeof body.authHash !== "string" || !body.kdfParams) {
    log(400, "bad_body");
    return json(400, { error: "wrappedPrivateKey, kdfParams, authHash required" });
  }

  const existing = await getCredential(env.DB, session.accountId, "password");
  const hadPassword = !!existing;

  // W71 — STEP-UP. Replacing the password used to need only a session cookie, so a stolen cookie was
  // a silent, permanent account takeover: set a new password, and the real owner is locked out of
  // their own health record with nothing to notice. Session revocation (also W71) shortens the window
  // a stolen cookie stays useful; it does not stop the cookie being used to seize the account inside
  // that window. Proving knowledge of the CURRENT password does.
  //
  // Only when there IS one. A passkey-only or Google-only account adding its first password has no
  // current password to prove, and demanding one would make that flow impossible rather than safe —
  // the session is the only evidence available, and no existing credential is being destroyed.
  // W73 — one implementation of the challenge, shared with the passkey and Google add-paths, which
  // had none until now. The behaviour here is unchanged: a first password on a passkey- or
  // Google-only account has nothing to prove, and stepUpForMethodChange returns ok for exactly that
  // case (see its header).
  const stepUp = await stepUpForMethodChange(env.DB, session.accountId, body.currentAuthHash);
  if (!stepUp.ok) { log(stepUp.status, stepUp.errorCode); return json(stepUp.status, { error: stepUp.message, errorCode: stepUp.errorCode }); }
  await putCredential(env.DB, {
    accountId: session.accountId,
    method: "password",
    wrappedPrivateKey: base64ToBytes(body.wrappedPrivateKey),
    kdfParams: { ...(body.kdfParams as Record<string, unknown>), authHashSha256: await sha256Base64Url(body.authHash) },
  });
  if (!hadPassword) {
    await addIdentity(env.DB, { accountId: session.accountId, method: "password" });
    await notifyMethodAdded(context, env, session.accountId, "password");
  }

  // W71 — replacing the password must end every session that the OLD password could have started.
  // It silently did not: a stolen cookie outlived the credential change by up to thirty days, which
  // is the single step a person takes when they believe they have been compromised. The caller's own
  // cookie is reissued below, so this signs out the other devices without signing out this one — the
  // behaviour a per-session id would give, reached without one.
  await revokeSessions(env.DB, session.accountId);
  const reissued = await signSession(env, session.accountId);

  log(200);
  return new Response(JSON.stringify({ ok: true, method: "password" }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(reissued) },
  });
}

// Remove a login method — refuse if it would leave the account with no usable login method (recovery is
// not redeemable/login, so it doesn't count as a fallback).
export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  let body: { method?: unknown };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }
  const method = body.method;
  if (method !== "password" && method !== "passkey" && method !== "google") { log(400, "bad_method"); return json(400, { error: "removable methods: password, passkey, google" }); }

  const creds = await listCredentials(env.DB, session.accountId);
  const present = new Set(creds.map((c) => c.method));
  if (!present.has(method)) { log(404, "not_present"); return json(404, { error: "method not set on this account" }); }
  const loginMethodsLeft = LOGIN_METHODS.filter((m) => present.has(m) && m !== method);
  if (loginMethodsLeft.length === 0) { log(409, "would_orphan"); return json(409, { error: "cannot remove your only login method" }); }

  await deleteCredential(env.DB, session.accountId, method);
  await deleteIdentity(env.DB, session.accountId, method);

  // Removing a login method is a revocation too — most obviously a lost passkey, where the sessions
  // that key already started are exactly what the removal is meant to reach. Same reissue as above so
  // the caller stays signed in on this device.
  await revokeSessions(env.DB, session.accountId);
  const reissued = await signSession(env, session.accountId);

  log(200);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionSetCookie(reissued) },
  });
}
