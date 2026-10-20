import type { D1Database } from "../../_lib/identity-types";
import { getAccount, getAccountByEmail } from "../../_lib/identity-accounts";
import { listVaultsForOwner } from "../../_lib/identity-vault";
import { requireSession } from "../../_lib/session";
import { pagesHandler } from "@tinytars/vault/adapters/pages-http";
import { D1AuditStore, D1ProviderLinkStore } from "@tinytars/vault/adapters/d1";
import { accessRequestHandler, type AccessRequestDeps } from "../../_lib/routes/access-request";

// W44 P4b — a support agent asks a patient for access, or a clinician for their roster. The body is
// shared with /api/providers/request; see _lib/routes/access-request.ts for why there are two mounts
// and not one widened path. This URL is unchanged and two shipped consumers still call it.
interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}

export const onRequestPost = pagesHandler<AccessRequestDeps, Env>(accessRequestHandler, ({ request, env }) => ({
  route: "/api/support/request",
  requireSession: () => requireSession(request, env),
  getAccount: (id) => getAccount(env.DB, id),
  getAccountByEmail: (email) => getAccountByEmail(env.DB, email),
  listVaultsForOwner: (ownerAccountId) => listVaultsForOwner(env.DB, ownerAccountId),
  links: new D1ProviderLinkStore(env.DB),
  audit: new D1AuditStore(env.DB),
}));
