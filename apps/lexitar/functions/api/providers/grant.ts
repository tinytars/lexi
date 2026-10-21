import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { listVaultsForOwner, putEnvelope } from "../../_lib/identity-vault";
import { createProviderLink, listProvidersForPatient, setLinkGrant } from "../../_lib/identity-providers";
import { insertAccessEvent } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { logRequest } from "../../_lib/log";
import { json } from "../../_lib/http";

// W44 P4 — patient-initiated, zero-knowledge grant. The logged-in patient has already wrapped their
// in-memory DEK to the provider's public key client-side (crypto.wrapDEKForPublicKey); this endpoint
// only records the opaque envelope + a provider_link. The server never sees a plaintext DEK.
// Re-granting an existing (possibly revoked) link is idempotent: the envelope is replaced and the link
// flipped back to active, so no duplicate rows accumulate — which is also the renewal path.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}
interface Ctx {
  request: Request;
  env: Env;
}

const ROUTE = "/api/providers/grant";

// How long the access lasts. The patient picks between a 30-day window and "ongoing", and the SERVER
// owns the arithmetic: a browser's clock does not get to set a consent window, so the body carries a
// count of days and never a date. Out of range is clamped rather than refused — the number is a
// preference, and refusing the whole grant over it would lose the consent the patient just gave.
// `null` is the patient choosing ongoing: no end date until they revoke. An ABSENT field is an older
// client rather than a request for permanence, so it takes the product default.
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 365;

function expiryFor(ttlDays: number | null): string | null {
  if (ttlDays === null) return null;
  const days = Math.min(Math.max(Math.round(ttlDays), 1), MAX_TTL_DAYS);
  return new Date(Date.now() + days * 86400 * 1000).toISOString();
}

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

  let body: { providerAccountId?: unknown; wrappedDEK?: unknown; ephemeralPublicKeyJwk?: unknown; ttlDays?: unknown };
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
  const ttlDays = body.ttlDays === undefined ? DEFAULT_TTL_DAYS : body.ttlDays;
  if (ttlDays !== null && (typeof ttlDays !== "number" || !Number.isFinite(ttlDays))) {
    log(400, "bad_ttl");
    return json(400, { error: "ttlDays must be a number of days, or null for no end date" });
  }
  const expiresAt = expiryFor(ttlDays);

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
  const consentRef = `patient-granted:${new Date().toISOString()}`;
  let linkId: string;
  if (existing) {
    // NOT `updateProviderLinkStatus`, whose statement is `SET status = ?` alone: a renewal through it
    // would flip the link active and silently keep whatever `expires_at` it already carried, which is
    // the one write where a stale date is indistinguishable from the patient's choice — and on a
    // lapsed link it would re-grant access that expires immediately. `setLinkGrant` writes status,
    // expiry and consent as one statement, so the row can never half-describe the decision.
    await setLinkGrant(env.DB, existing.id, { expiresAt, consentRef });
    linkId = existing.id;
  } else {
    const link = await createProviderLink(env.DB, {
      ownerAccountId: session.accountId,
      providerAccountId,
      role: provider.providerKind,
      status: "active",
      grantedBy: session.accountId,
      expiresAt,
      consentRef,
    });
    linkId = link.id;
  }

  // The patient's own access screen is where they learn who can read their record, and until now a
  // grant was the one consent event that left no row on it — `provider_access_revoked` was written,
  // its opposite was not, so the log read as if access had always been there. Actor and subject are
  // both the owner: this is their act on their own record, which is exactly why it does NOT go
  // through the privileged-read chokepoint in `_lib/phi-audit.ts`, whose owner exclusion — right for
  // a disclosure, wrong for a consent change — would drop it. (Naming that helper here would be a
  // false positive for the sweep in tests/unit/audit-chokepoint.test.ts, which reads mentions as
  // call sites; the pointer is the path instead.)
  //
  // Not wrapped: a failed insert surfaces as a 500 and the client retries, which is safe because this
  // route is idempotent in both of its branches. The same trade `providers-link-revoke.ts` makes.
  await insertAccessEvent(env.DB, {
    actorAccountId: session.accountId,
    subjectAccountId: session.accountId,
    vaultId: vault.vaultId,
    action: "provider_access_granted",
    consentRef,
    meta: { providerAccountId, expiresAt },
  });

  log(200);
  return json(200, {
    ok: true,
    linkId,
    providerAccountId,
    displayName: provider.displayName,
    kind: provider.providerKind,
    expiresAt,
  });
}
