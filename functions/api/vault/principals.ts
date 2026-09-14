import type { D1Database } from "../../_lib/identity-types";
import { getPublicKey } from "../../_lib/identity-credentials";
import { listEnvelopesForVault, listVaultsForOwner } from "../../_lib/identity-vault";
import { listProvidersForPatient } from "../../_lib/identity-providers";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { ORG_ACCOUNT_ID } from "../../_lib/org";

// W44 P4c — the re-wrap targets for a DEK rotation: the owner's own public key, the org-recovery public
// key, and every ACTIVE provider's public key (the principals that must keep access after the re-key).
// The revoked/expired support principal is not active, so it's excluded — losing access, which is the point.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/vault/principals";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) => logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) { log(401, "unauthorized"); return session; }

  const vault = (await listVaultsForOwner(env.DB, session.accountId))[0];
  if (!vault) { log(404, "no_vault"); return json(404, { error: "no vault" }); }

  const self = await getPublicKey(env.DB, session.accountId);
  const org = await getPublicKey(env.DB, ORG_ACCOUNT_ID);
  if (!self || !org) { log(500, "missing_keys"); return json(500, { error: "missing owner or org public key" }); }

  const providers: { accountId: string; publicKeyJwk: unknown }[] = [];
  for (const link of await listProvidersForPatient(env.DB, session.accountId)) {
    if (link.status !== "active") continue;
    const pk = await getPublicKey(env.DB, link.providerAccountId);
    if (pk) providers.push({ accountId: link.providerAccountId, publicKeyJwk: pk.publicKeyJwk });
  }

  const envelopePrincipalIds = (await listEnvelopesForVault(env.DB, vault.vaultId)).map((e) => e.principalAccountId);

  log(200);
  return json(200, {
    vaultId: vault.vaultId,
    selfAccountId: session.accountId,
    orgAccountId: ORG_ACCOUNT_ID,
    selfPublicKeyJwk: self.publicKeyJwk,
    orgPublicKeyJwk: org.publicKeyJwk,
    providers,
    envelopePrincipalIds,
    orgRecoveryRevokedAt: vault.orgRecoveryRevokedAt,
  });
}
