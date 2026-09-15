import type { D1Database } from "../../_lib/identity-types";
import { getAccount } from "../../_lib/identity-accounts";
import { getEnvelope, listVaultsForOwner } from "../../_lib/identity-vault";
import { listPatientsForProvider } from "../../_lib/identity-providers";
import { insertAccessEvent } from "../../_lib/identity-audit";
import { requireSession } from "../../_lib/session";
import { pagesHandler } from "@tinytars/vault/adapters/pages-http";
import { D1AuditStore, D1EnvelopeStore, D1ProviderLinkStore } from "@tinytars/vault/adapters/d1";
import { supportAccessHandler, type SupportAccessDeps } from "../../_lib/routes/support-access";

interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
}

export const onRequestPost = pagesHandler<SupportAccessDeps, Env>(supportAccessHandler, ({ request, env }) => ({
  requireSession: () => requireSession(request, env),
  getAccount: (id) => getAccount(env.DB, id),
  listPatientsForProvider: (providerAccountId) => listPatientsForProvider(env.DB, providerAccountId),
  listVaultsForOwner: (ownerAccountId) => listVaultsForOwner(env.DB, ownerAccountId),
  getEnvelope: (vaultId, principalAccountId) => getEnvelope(env.DB, vaultId, principalAccountId),
  insertAccessEvent: (e) => insertAccessEvent(env.DB, e),
  links: new D1ProviderLinkStore(env.DB),
  audit: new D1AuditStore(env.DB),
  envelopes: new D1EnvelopeStore(env.DB),
}));
