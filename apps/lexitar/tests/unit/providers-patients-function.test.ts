import { describe, it, expect } from "vitest";
import { onRequestGet as patients } from "../../functions/api/providers/patients";
import type { LinkStatus } from "../../functions/_lib/identity-types";
import { createAccount } from "../../functions/_lib/identity-accounts";
import { putPublicKey } from "../../functions/_lib/identity-credentials";
import { createVault, putEnvelope } from "../../functions/_lib/identity-vault";
import { createProviderLink } from "../../functions/_lib/identity-providers";
import { generateAccountKeypair, generateDEK, wrapDEKForPublicKey } from "@tinytars/vault/crypto";
import { useWorkerd } from "../support/miniflare";
import { SESSION_SECRET, cookieFor } from "../support/session";

const w = useWorkerd();
const makeEnv = () => ({ DB: w.db, SESSION_SECRET });

// Seed one provider + one patient (owned vault). Optionally grant the provider an envelope and
// set the link status. Returns their ids so the caller can sign a session for the provider.
async function seed(displayName: string, opts: { status?: LinkStatus; grantEnvelope?: boolean } = {}) {
  const prov = await generateAccountKeypair();
  const providerId = crypto.randomUUID();
  await createAccount(w.db, { id: providerId, displayName: "Prov", providerKind: "primary" });
  await putPublicKey(w.db, { accountId: providerId, publicKeyJwk: prov.publicKeyJwk });

  const patientId = crypto.randomUUID();
  await createAccount(w.db, { id: patientId, displayName });
  const vaultId = crypto.randomUUID();
  await createVault(w.db, { vaultId, ownerAccountId: patientId, r2Key: `data-${patientId}.enc`, hd1Version: 2 });

  if (opts.grantEnvelope ?? true) {
    const dek = await generateDEK();
    const env0 = await wrapDEKForPublicKey(dek, prov.publicKeyJwk);
    await putEnvelope(w.db, {
      vaultId,
      principalAccountId: providerId,
      wrappedDek: env0.wrappedDEK,
      ephemeralPublicKeyJwk: env0.ephemeralPublicKeyJwk,
      createdBy: providerId,
    });
  }
  await createProviderLink(w.db, {
    ownerAccountId: patientId,
    providerAccountId: providerId,
    role: "primary",
    status: opts.status ?? "active",
    grantedBy: providerId,
  });
  return { providerId, patientId, vaultId, displayName };
}

async function get(providerId: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (providerId) headers.cookie = await cookieFor(providerId);
  return patients({ request: new Request("http://x/api/providers/patients", { headers }), env: makeEnv() });
}

describe("GET /api/providers/patients", () => {
  it("401s without a session", async () => {
    expect((await get(null)).status).toBe(401);
  });

  it("returns active patients the provider has an envelope for, with the wrapped DEK", async () => {
    const { providerId, patientId, vaultId } = await seed("Alice Active");
    const res = await get(providerId);
    expect(res.status).toBe(200);
    const { patients: list } = (await res.json()) as {
      patients: { ownerAccountId: string; displayName: string; vaultId: string; envelope: { wrappedDEK: string } }[];
    };
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ownerAccountId: patientId, displayName: "Alice Active", vaultId });
    expect(list[0].envelope.wrappedDEK).toBeTruthy();
  });

  it("omits a link that is not active", async () => {
    const { providerId } = await seed("Ivan Invited", { status: "invited" });
    const { patients: list } = (await (await get(providerId)).json()) as { patients: unknown[] };
    expect(list).toHaveLength(0);
  });

  it("omits a patient the provider has no envelope for", async () => {
    const { providerId } = await seed("Nora NoEnvelope", { grantEnvelope: false });
    const { patients: list } = (await (await get(providerId)).json()) as { patients: unknown[] };
    expect(list).toHaveLength(0);
  });
});
