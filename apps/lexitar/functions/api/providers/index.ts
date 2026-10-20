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
    // The patient's Approve wraps their DEK to the ASKER's public key in the browser, so the key has
    // to reach them. This was gated on `status === "invited"` — and before that on `role ===
    // "support"` too, which was indistinguishable from the status test while an invited link could
    // only ever be a support one, until /api/providers/request made invited+primary possible; the
    // narrow test failed silently rather than loudly, because `approve()` returns early on a missing
    // key and the patient would press Approve and watch nothing happen.
    //
    // The gate is gone entirely now, because renewing access is spelled as re-granting it: moving a
    // window goes through /api/providers/grant like any other consent, which means re-wrapping the
    // DEK, which means the key is needed for a link that is already active or has lapsed — exactly the
    // rows the old condition excluded. Nothing is disclosed by it: it is a public key, and the
    // patient wrapped their DEK to it already. Revoked links never reach here (`continue`, above),
    // so no key is handed out for access that has been withdrawn.
    entry.publicKeyJwk = (await getPublicKey(env.DB, acct.id))?.publicKeyJwk ?? null;
    providers.push(entry);
  }

  log(200);
  return json(200, { providers });
}
