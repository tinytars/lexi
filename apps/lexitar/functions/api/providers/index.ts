import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { getPublicKey } from "../../_lib/identity-credentials";
import { listProvidersForPatient } from "../../_lib/identity-providers";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";

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
    // A pending request needs the ASKER's public key, so the patient's Approve can wrap their DEK to
    // it. This read "a pending support request" and tested for `role === "support"` as well, which
    // was indistinguishable from the line below while an invited link could only ever be a support
    // one. /api/providers/request makes invited+primary possible, and the narrow test fails silently
    // rather than loudly: `approve()` returns early on a missing `publicKeyJwk`, so the patient would
    // press Approve and watch nothing happen.
    if (link.status === "invited") {
      entry.publicKeyJwk = (await getPublicKey(env.DB, acct.id))?.publicKeyJwk ?? null;
    }
    providers.push(entry);
  }

  log(200);
  return json(200, { providers });
}
