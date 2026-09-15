import type { D1Database } from "../../_lib/identity-types";
import { listVaultsForOwner } from "../../_lib/identity-vault";
import { requireSession } from "../../_lib/session";
import { pagesHandler } from "@tinytars/vault/adapters/pages-http";
import { D1AuditStore, D1EnvelopeStore, D1ProviderLinkStore } from "@tinytars/vault/adapters/d1";
import { supportApproveHandler, type SupportApproveDeps } from "../../_lib/routes/support-approve";

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}

export const onRequestPost = pagesHandler<SupportApproveDeps, Env>(supportApproveHandler, ({ request, env }) => ({
  requireSession: () => requireSession(request, env),
  links: new D1ProviderLinkStore(env.DB),
  audit: new D1AuditStore(env.DB),
  envelopes: new D1EnvelopeStore(env.DB),
  listVaultsForOwner: (ownerAccountId) => listVaultsForOwner(env.DB, ownerAccountId),
}));
