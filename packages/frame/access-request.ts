// A provider asks someone for access. The other half of consent.
//
// `@tinytars/vault`'s `requestSupportAccess` posts exactly this body, and calling it would have been
// one import — except that it hardcodes `/api/support/request`. The server mounts one handler at two
// URLs so that each caller can travel a path that names it; spending that on the client would leave
// the honest path with no caller and the support path carrying clinicians, which is the arrangement
// the two mounts exist to avoid. It lives here rather than in `@tinytars/vault` because this needs no
// release of that package.

import { failed } from "@tinytars/vault/auth-client";

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
