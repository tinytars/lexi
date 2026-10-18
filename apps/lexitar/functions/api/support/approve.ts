import type { D1Database } from "../../_lib/identity-types";
import { listVaultsForOwner } from "../../_lib/identity-vault";
import { requireSession } from "../../_lib/session";
import { accountEmailLookup, supportAccessNotifier } from "../../_lib/notify-support";
import { pagesHandler } from "@tinytars/vault/adapters/pages-http";
import { D1AuditStore, D1EnvelopeStore, D1ProviderLinkStore } from "@tinytars/vault/adapters/d1";
import { supportApproveHandler, type SupportApproveDeps } from "../../_lib/routes/support-approve";

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  GMAIL_SA_CLIENT_EMAIL?: string;
  GMAIL_SA_PRIVATE_KEY?: string;
  GMAIL_SENDER?: string;
  EMAIL_FROM?: string;
}

// Pages passes the whole context to buildDeps, waitUntil included; the adapter's type stops at
// {request, env, params}, so the one member this route needs is named here rather than reached for
// through a cast — the notice must not sit between the patient and their response.
export const onRequestPost = pagesHandler<SupportApproveDeps, Env>(supportApproveHandler, ({ request, env, waitUntil }: { request: Request; env: Env; waitUntil?: (p: Promise<unknown>) => void }) => ({
  requireSession: () => requireSession(request, env),
  links: new D1ProviderLinkStore(env.DB),
  audit: new D1AuditStore(env.DB),
  envelopes: new D1EnvelopeStore(env.DB),
  listVaultsForOwner: (ownerAccountId) => listVaultsForOwner(env.DB, ownerAccountId),
  notify: supportAccessNotifier({ waitUntil }, env, accountEmailLookup(env.DB)),
}));
