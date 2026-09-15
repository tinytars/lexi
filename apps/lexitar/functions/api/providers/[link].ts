import type { D1Database } from "../../_lib/identity-types";
import { listVaultsForOwner } from "../../_lib/identity-vault";
import { getProviderLink } from "../../_lib/identity-providers";
import { requireSession } from "../../_lib/session";
import { pagesHandler } from "@tinytars/vault/adapters/pages-http";
import { D1AuditStore, D1EnvelopeStore, D1ProviderLinkStore } from "@tinytars/vault/adapters/d1";
import { providersLinkRevokeHandler, type ProvidersLinkRevokeDeps } from "../../_lib/routes/providers-link-revoke";

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}

export const onRequestDelete = pagesHandler<ProvidersLinkRevokeDeps, Env, { link: string }>(
  providersLinkRevokeHandler,
  ({ request, env, params }) => ({
    requireSession: () => requireSession(request, env),
    linkId: params.link,
    getProviderLink: (id) => getProviderLink(env.DB, id),
    listVaultsForOwner: (ownerAccountId) => listVaultsForOwner(env.DB, ownerAccountId),
    links: new D1ProviderLinkStore(env.DB),
    audit: new D1AuditStore(env.DB),
    envelopes: new D1EnvelopeStore(env.DB),
  })
);
