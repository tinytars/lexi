import type { D1Database } from "../../_lib/identity-types";
import { putCredential } from "../../_lib/identity-credentials";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { sha256Base64Url } from "../../_lib/verifier";
import { json } from "../../_lib/http";

// W44 P8b — regenerate the recovery code (session-gated). The client re-wrapped its in-memory private
// key under a fresh code and computed the code's authHash; we store the wrapped key + SHA-256(authHash)
// as the recovery credential (INSERT OR REPLACE replaces the old one). Powers the Account "regenerate"
// button and the pilot-provisioning script. Never sees the code, KEK, or key.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/account/recovery";

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

  let body: { wrappedPrivateKey?: unknown; kdfParams?: unknown; recoveryAuthHash?: unknown };
  try { body = await request.json(); } catch { log(400, "bad_json"); return json(400, { error: "invalid JSON" }); }
  if (typeof body.wrappedPrivateKey !== "string" || typeof body.recoveryAuthHash !== "string" || !body.kdfParams) {
    log(400, "bad_body");
    return json(400, { error: "wrappedPrivateKey, kdfParams, recoveryAuthHash required" });
  }

  await putCredential(env.DB, {
    accountId: session.accountId,
    method: "recovery",
    wrappedPrivateKey: base64ToBytes(body.wrappedPrivateKey),
    kdfParams: { ...(body.kdfParams as Record<string, unknown>), authHashSha256: await sha256Base64Url(body.recoveryAuthHash) },
  });

  log(200);
  return json(200, { ok: true });
}
