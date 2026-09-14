import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { getEnvelope, listVaultsForOwner } from "../../_lib/identity-vault";
import { listPatientsForProvider } from "../../_lib/identity-providers";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W44 cutover — the provider's patient list, replacing the old fam4 `data.enc` roster. Returns
// each active patient the session provider can actually open: their display name, vault id/r2 key,
// and the provider's OWN envelope for that vault (the wrapped DEK the provider unwraps client-side
// with its private key). A patient with no envelope granted to this provider is silently omitted —
// the envelope, not the row, is the access boundary.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/providers/patients";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

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

  const links = await listPatientsForProvider(env.DB, session.accountId);
  const patients: unknown[] = [];
  for (const link of links) {
    // Clinician read path only — support enters via the audited /api/support/access (W44 P4b).
    if (link.status !== "active" || link.role === "support") continue;
    const acct = await getAccount(env.DB, link.ownerAccountId);
    if (!acct) continue;
    const vault = (await listVaultsForOwner(env.DB, link.ownerAccountId))[0];
    if (!vault) continue;
    const envelope = await getEnvelope(env.DB, vault.vaultId, session.accountId);
    if (!envelope) continue;
    patients.push({
      ownerAccountId: acct.id,
      displayName: acct.displayName,
      email: acct.email,
      linkId: link.id, // W48 — lets the provider DELETE /api/providers/{linkId} to drop this patient
      vaultId: vault.vaultId,
      r2Key: vault.r2Key,
      envelope: {
        wrappedDEK: bytesToBase64(envelope.wrappedDek),
        ephemeralPublicKeyJwk: envelope.ephemeralPublicKeyJwk,
      },
    });
  }

  log(200);
  return json(200, { patients });
}
