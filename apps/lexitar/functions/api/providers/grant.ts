import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { listVaultsForOwner, putEnvelope } from "../../_lib/identity-vault";
import { createProviderLink, listProvidersForPatient, updateProviderLinkStatus } from "../../_lib/identity-providers";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";

// W44 P4 — patient-initiated, zero-knowledge grant. The logged-in patient has already wrapped their
// in-memory DEK to the provider's public key client-side (crypto.wrapDEKForPublicKey); this endpoint
// only records the opaque envelope + a provider_link. The server never sees a plaintext DEK.
// Re-granting an existing (possibly revoked) link is idempotent: the envelope is replaced and the link
// flipped back to active, so no duplicate rows accumulate.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/providers/grant";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestPost(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, errorCode });

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }

  let body: { providerAccountId?: unknown; wrappedDEK?: unknown; ephemeralPublicKeyJwk?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON" });
  }
  const { providerAccountId, wrappedDEK, ephemeralPublicKeyJwk } = body;
  if (typeof providerAccountId !== "string" || typeof wrappedDEK !== "string" || !ephemeralPublicKeyJwk) {
    log(400, "bad_body");
    return json(400, { error: "providerAccountId, wrappedDEK, ephemeralPublicKeyJwk required" });
  }
  if (providerAccountId === session.accountId) {
    log(400, "self_grant");
    return json(400, { error: "cannot grant to yourself" });
  }

  const provider = await getAccount(env.DB, providerAccountId);
  if (!provider || !provider.providerKind) {
    log(400, "not_a_provider");
    return json(400, { error: "not a provider" });
  }

  const vault = (await listVaultsForOwner(env.DB, session.accountId))[0];
  if (!vault) {
    log(400, "no_vault");
    return json(400, { error: "no vault to share" });
  }

  await putEnvelope(env.DB, {
    vaultId: vault.vaultId,
    principalAccountId: providerAccountId,
    wrappedDek: base64ToBytes(wrappedDEK),
    ephemeralPublicKeyJwk,
    createdBy: session.accountId,
  });

  const existing = (await listProvidersForPatient(env.DB, session.accountId)).find(
    (l) => l.providerAccountId === providerAccountId
  );
  let linkId: string;
  if (existing) {
    await updateProviderLinkStatus(env.DB, existing.id, "active");
    linkId = existing.id;
  } else {
    const link = await createProviderLink(env.DB, {
      ownerAccountId: session.accountId,
      providerAccountId,
      role: provider.providerKind,
      status: "active",
      grantedBy: session.accountId,
    });
    linkId = link.id;
  }

  log(200);
  return json(200, { ok: true, linkId, providerAccountId, displayName: provider.displayName, kind: provider.providerKind });
}
