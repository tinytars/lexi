// The patient's push signal: an account other than theirs can read their record, and it just did.
//
// The screen already shows both facts (App.svelte's Access panel reads phi_access_events), so what is
// pinned here is what a screen cannot be: that the mail goes out at all, and that it goes out ONCE per
// approved window rather than once per read. An unattended export runs every day for a week against one
// approval, and a notice per run is a notice nobody reads — which would cost the patient the signal that
// matters instead of giving them one.

import { describe, it, expect } from "vitest";
import { supportApproveHandler } from "../../functions/_lib/routes/support-approve";
import { supportAccessHandler, type SupportAccessDeps } from "../../functions/_lib/routes/support-access";
import { supportAccessNotifier } from "../../functions/_lib/notify-support";
import { MemoryProviderLinkStore, MemoryAuditStore, MemoryEnvelopeStore } from "@tinytars/vault/adapters/memory";
import type { Account, ProviderLink, VaultRow } from "@tinytars/vault/stores";

const post = (body: unknown) =>
  new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const session = (accountId: string) => async () => ({ accountId });

const OWNER = "patient-1";
const SUPPORT = "support-1";
const VAULT: VaultRow = {
  vaultId: "vault-1",
  ownerAccountId: OWNER,
  r2Key: "k",
  hd1Version: 2,
  rotationPending: false,
  orgRecoveryRevokedAt: null,
  rotationStagingR2Key: null,
};
const SUPPORT_ACCOUNT: Account = {
  id: SUPPORT,
  email: null,
  emailConfirmed: false,
  displayName: "Record Export CLI",
  lifecycleStage: "active",
  providerKind: "support",
  unitSystem: null,
  createdAt: new Date().toISOString(),
};

type Notice = Parameters<SupportAccessDeps["notify"]>[0];

function recorder() {
  const sent: Notice[] = [];
  return { sent, notify: async (n: Notice) => void sent.push(n) };
}

async function openRecord(over: Partial<SupportAccessDeps> & { link: ProviderLink }) {
  const { link, ...rest } = over;
  const events: { action: string }[] = [];
  const notice = recorder();
  const res = await supportAccessHandler(post({ ownerAccountId: OWNER }), {
    requireSession: session(SUPPORT),
    getAccount: async () => SUPPORT_ACCOUNT,
    listPatientsForProvider: async () => [link],
    listVaultsForOwner: async () => [VAULT],
    getEnvelope: async () => ({
      vaultId: VAULT.vaultId,
      principalAccountId: SUPPORT,
      wrappedDek: new Uint8Array([1]),
      ephemeralPublicKeyJwk: {},
      createdBy: OWNER,
      createdAt: new Date().toISOString(),
    }),
    insertAccessEvent: async (e) => void events.push({ action: e.action }),
    countOpensInWindow: async () => 0,
    notify: notice.notify,
    links: new MemoryProviderLinkStore(),
    audit: new MemoryAuditStore(),
    envelopes: new MemoryEnvelopeStore(),
    ...rest,
  });
  return { res, events, sent: notice.sent };
}

async function activeLink(links: MemoryProviderLinkStore, over: Partial<ProviderLink> = {}): Promise<ProviderLink> {
  const link = await links.create({
    ownerAccountId: OWNER,
    providerAccountId: SUPPORT,
    role: "support",
    status: "active",
    grantedBy: OWNER,
    expiresAt: new Date(Date.now() + 168 * 3600_000).toISOString(),
  });
  return { ...link, consentRef: "patient-approved:2026-09-27T00:00:00.000Z", ...over };
}

describe("approving support access tells the patient", () => {
  it("names the window it just opened, in the same expiry the route returned", async () => {
    const links = new MemoryProviderLinkStore();
    const link = await links.create({ ownerAccountId: OWNER, providerAccountId: SUPPORT, role: "support", status: "invited", grantedBy: OWNER });
    const notice = recorder();

    const res = await supportApproveHandler(
      post({ linkId: link.id, wrappedDEK: btoa("dek"), ephemeralPublicKeyJwk: { kty: "EC" }, ttlHours: 168 }),
      {
        requireSession: session(OWNER),
        links,
        audit: new MemoryAuditStore(),
        envelopes: new MemoryEnvelopeStore(),
        listVaultsForOwner: async () => [VAULT],
        notify: notice.notify,
      },
    );

    const body = (await res.json()) as { expiresAt: string };
    expect(notice.sent).toEqual([{ ownerAccountId: OWNER, event: "approved", expiresAt: body.expiresAt }]);
  });

  it("sends nothing when there was no pending request to approve", async () => {
    const notice = recorder();
    const res = await supportApproveHandler(post({ linkId: "nope", wrappedDEK: btoa("x"), ephemeralPublicKeyJwk: {} }), {
      requireSession: session(OWNER),
      links: new MemoryProviderLinkStore(),
      audit: new MemoryAuditStore(),
      envelopes: new MemoryEnvelopeStore(),
      listVaultsForOwner: async () => [VAULT],
      notify: notice.notify,
    });
    expect(res.status).toBe(403);
    expect(notice.sent).toEqual([]);
  });
});

describe("the first open of a window tells the patient, and the rest do not", () => {
  it("mails on the open that has no earlier row in its window", async () => {
    const links = new MemoryProviderLinkStore();
    const link = await activeLink(links);
    const { res, sent } = await openRecord({ link, countOpensInWindow: async () => 0 });
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ ownerAccountId: OWNER, event: "opened", expiresAt: link.expiresAt }]);
  });

  it("stays silent on every later open, while still recording it", async () => {
    const links = new MemoryProviderLinkStore();
    const { res, events, sent } = await openRecord({ link: await activeLink(links), countOpensInWindow: async () => 1 });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ action: "support_access_opened" }]);
    expect(sent).toEqual([]);
  });

  it("counts within the window it was asked about, not across the patient's whole history", async () => {
    const links = new MemoryProviderLinkStore();
    const link = await activeLink(links);
    const asked: { subject: string; consentRef: string }[] = [];
    await openRecord({
      link,
      countOpensInWindow: async (subject, consentRef) => (asked.push({ subject, consentRef }), 0),
    });
    expect(asked).toEqual([{ subject: OWNER, consentRef: link.consentRef }]);
  });

  it("records an open it cannot attribute to a window, and mails nobody about it", async () => {
    const links = new MemoryProviderLinkStore();
    const { events, sent } = await openRecord({
      link: await activeLink(links, { consentRef: null }),
      countOpensInWindow: async () => {
        throw new Error("must not be asked without a consent ref");
      },
    });
    expect(events).toEqual([{ action: "support_access_opened" }]);
    expect(sent).toEqual([]);
  });
});

describe("the notifier itself", () => {
  const env = { SESSION_SECRET: "s" };

  it("does not reject when the send fails, because the access has already happened", async () => {
    const notify = supportAccessNotifier({}, { ...env, GMAIL_SA_CLIENT_EMAIL: "sa@x", GMAIL_SA_PRIVATE_KEY: "not-a-key", GMAIL_SENDER: "n@x" }, async () => "p@example.test");
    await expect(notify({ ownerAccountId: OWNER, event: "opened", expiresAt: null })).resolves.toBeUndefined();
  });

  it("sends nothing to an account with no address on file", async () => {
    let asked = false;
    const notify = supportAccessNotifier({ waitUntil: () => (asked = true) }, env, async () => null);
    await notify({ ownerAccountId: OWNER, event: "approved", expiresAt: null });
    expect(asked).toBe(false);
  });
});
