import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { requireSession } from "../../_lib/session";
import { pagesHandler } from "@tinytars/vault/adapters/pages-http";
import { D1AuditStore, D1ProviderLinkStore } from "@tinytars/vault/adapters/d1";
import { providersApproveSupportHandler, type ProvidersApproveSupportDeps } from "../../_lib/routes/providers-approve-support";

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}

export const onRequestPost = pagesHandler<ProvidersApproveSupportDeps, Env>(providersApproveSupportHandler, ({ request, env }) => ({
  requireSession: () => requireSession(request, env),
  getAccount: (id) => getAccount(env.DB, id),
  links: new D1ProviderLinkStore(env.DB),
  audit: new D1AuditStore(env.DB),
}));
