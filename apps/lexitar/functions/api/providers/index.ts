import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { getPublicKey } from "../../_lib/identity-credentials";
import { listProvidersForPatient } from "../../_lib/identity-providers";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W44 P4 — the patient-side "who can see me" view (complements /api/providers/patients, the
// provider→patients view). Lists this account's provider links (excluding revoked) with the
// provider's display name + kind, so the owner UI can show them and offer a revoke.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/providers";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  const links = await listProvidersForPatient(env.DB, session.accountId);
  const providers: unknown[] = [];
  for (const link of links) {
    if (link.status === "revoked") continue;
    const acct = await getAccount(env.DB, link.providerAccountId);
    if (!acct) continue;
    const entry: Record<string, unknown> = {
      linkId: link.id,
      providerAccountId: acct.id,
      displayName: acct.displayName,
      kind: link.role,
      status: link.status,
      expiresAt: link.expiresAt,
    };
    // A pending support request needs the agent's public key so the patient's Approve can wrap the DEK.
    if (link.role === "support" && link.status === "invited") {
      entry.publicKeyJwk = (await getPublicKey(env.DB, acct.id))?.publicKeyJwk ?? null;
    }
    providers.push(entry);
  }

  log(200);
  return json(200, { providers });
}
