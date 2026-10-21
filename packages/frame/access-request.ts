// A provider asks someone for access. The other half of consent.
//
// `@tinytars/vault`'s `requestSupportAccess` posts exactly this body, and calling it would have been
// one import — except that it hardcodes `/api/support/request`. The server mounts one handler at two
// URLs so that each caller can travel a path that names it; spending that on the client would leave
// the honest path with no caller and the support path carrying clinicians, which is the arrangement
// the two mounts exist to avoid. It lives here rather than in `@tinytars/vault` because this needs no
// release of that package.

import { failed } from "@tinytars/vault/auth-client";
import { bytesToB64 } from "@tinytars/vault/base64";
import { wrapDEKForPublicKey } from "@tinytars/vault/crypto";

/**
 * Creates a pending (invited) link from the caller to the account at `ownerEmail`, and nothing else.
 * No key moves: approving is the subject's own browser act. Idempotent — asking twice returns the
 * standing link rather than queueing a second thing for them to answer.
 */
export async function requestAccessAsProvider(ownerEmail: string): Promise<void> {
  const res = await fetch("/api/providers/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerEmail }),
  });
  if (!res.ok) throw await failed(res, "request failed");
}

/**
 * Grants a provider access for a stated number of days, or for as long as the owner leaves it alone.
 *
 * `@tinytars/vault`'s own `grantProvider` posts the same envelope to the same URL and is one import
 * away — minus the one field that makes a grant a decision rather than a permanence. `ttlDays` is a
 * COUNT and never a date: the server computes the expiry from its own clock, so a wrong clock here
 * cannot shorten or extend a consent window. `null` is the owner choosing no end date.
 *
 * Re-granting an existing link is how a renewal is spelled: the route writes status, expiry and
 * consent together, so the same call moves a window, removes one, or restores access that lapsed.
 */
export async function grantProviderUntil(
  dek: CryptoKey,
  provider: { providerAccountId: string; publicKeyJwk: JsonWebKey },
  ttlDays: number | null
): Promise<void> {
  const env = await wrapDEKForPublicKey(dek, provider.publicKeyJwk);
  const res = await fetch("/api/providers/grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerAccountId: provider.providerAccountId,
      wrappedDEK: bytesToB64(env.wrappedDEK),
      ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk,
      ttlDays,
    }),
  });
  if (!res.ok) throw await failed(res, "grant failed");
}
