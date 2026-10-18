// W75 item 13 — the support-access half of auth-client.ts. See auth-client-grants.test.ts's header
// for why these are three files rather than one, and why the fetch stub records instead of mocking.
//
// Support access is the most consequential unaudited path in the module: an agent asks, a patient
// approves for a bounded time, and entering is server-audited. What is client-side here is which
// endpoint gets called with what — and, on `enterSupportOwner`, that the envelope it returns opens
// the patient's vault with the AGENT's own key and nothing weaker.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  requestSupportAccess,
  listSupportOwners,
  enterSupportOwner,
  approveSupportAsProvider,
  listSupportProviders,
  getProviderRoster,
  listSupportRequests,
  cancelSupportRequest,
  approveSupport,
} from "@tinytars/vault/auth-support";
import { generateAccountKeypair, generateDEK, unwrapDEKWithPrivateKey, encryptVaultV2, decryptVaultV2, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

interface Sent { url: string; method: string; body: any }
let sent: Sent[] = [];
let respond: (url: string) => Response;
const realFetch = globalThis.fetch;

const json = (status: number, b: unknown) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sent = [];
  respond = () => json(200, {});
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    sent.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    return respond(url);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("an agent asking for access", () => {
  it("sends only the patient's address — the request itself carries no key material", async () => {
    await requestSupportAccess("patient@example.com");
    expect(sent[0]).toMatchObject({ url: "/api/support/request", method: "POST" });
    expect(sent[0].body).toEqual({ ownerEmail: "patient@example.com" });
  });

  it("throws when the server refuses, rather than leaving the UI showing a request that was never made", async () => {
    respond = () => json(404, {});
    await expect(requestSupportAccess("nobody@example.com")).rejects.toThrow(/request failed \(404\)/);
  });

  it("cancels a pending request through the provider-link DELETE, id-escaped", async () => {
    await cancelSupportRequest("l 1");
    expect(sent[0]).toMatchObject({ url: "/api/providers/l%201", method: "DELETE" });
  });
});

describe("what an agent can see", () => {
  it("lists granted patients, and asks for no cached copy of who they are", async () => {
    respond = () => json(200, { owners: [{ ownerAccountId: "p1", displayName: "A", expiresAt: null }] });
    expect(await listSupportOwners()).toEqual([{ ownerAccountId: "p1", displayName: "A", expiresAt: null }]);
    expect(sent[0].url).toBe("/api/support/owners");
  });

  it("unwraps each list endpoint's own envelope key", async () => {
    respond = (url) =>
      url.includes("providers") && !url.includes("roster")
        ? json(200, { providers: [{ accountId: "prov" }] })
        : url.includes("roster")
          ? json(200, { roster: [{ ownerAccountId: "p9" }] })
          : json(200, { requests: [{ linkId: "l1" }] });
    expect(await listSupportProviders()).toEqual([{ accountId: "prov" }]);
    expect(await getProviderRoster("prov 1")).toEqual([{ ownerAccountId: "p9" }]);
    expect(await listSupportRequests()).toEqual([{ linkId: "l1" }]);
    expect(sent[1].url).toBe("/api/support/provider-roster?providerId=prov%201");
  });

  it("throws on a failed roster read instead of rendering an empty roster", async () => {
    respond = () => json(500, {});
    await expect(getProviderRoster("p")).rejects.toThrow(/provider roster failed \(500\)/);
  });
});

describe("entering a patient", () => {
  it("returns an envelope that opens the patient's vault with the agent's own key", async () => {
    const agent = await generateAccountKeypair();
    const dek = await generateDEK();
    const sealed = await encryptVaultV2({ ldl: 120 }, dek);
    const env = await wrapDEKForPublicKey(dek, agent.publicKeyJwk);
    respond = () =>
      json(200, {
        ownerAccountId: "p1",
        displayName: "A",
        email: null,
        vaultId: "v1",
        r2Key: "data-v1.enc",
        envelope: { wrappedDEK: bytesToBase64(env.wrappedDEK), ephemeralPublicKeyJwk: env.ephemeralPublicKeyJwk },
      });

    const got = await enterSupportOwner("p1");
    expect(sent[0]).toMatchObject({ url: "/api/support/access", method: "POST" });
    expect(sent[0].body).toEqual({ ownerAccountId: "p1" });

    const opened = await unwrapDEKWithPrivateKey(base64ToBytes(got.envelope.wrappedDEK), got.envelope.ephemeralPublicKeyJwk, agent.privateKey);
    expect(await decryptVaultV2(sealed, opened)).toEqual({ ldl: 120 });
  });

  it("throws when access is refused — an expired grant must not return a half-populated patient", async () => {
    respond = () => json(403, { error: "that access window has expired" });
    await expect(enterSupportOwner("p1")).rejects.toThrow("that access window has expired");
  });
});

describe("the time box", () => {
  // The patient's approval carries a TTL and the provider's does not — the provider is approving on
  // behalf of their own roster, where the hours come from the same argument but a different endpoint.
  it("is sent on both approval paths and named the same way", async () => {
    const agent = await generateAccountKeypair();
    await approveSupport("l1", await generateDEK(), agent.publicKeyJwk, 2);
    await approveSupportAsProvider("l2", 8);
    expect(sent[0].body.ttlHours).toBe(2);
    expect(sent[1]).toMatchObject({ url: "/api/providers/approve-support", method: "POST" });
    expect(sent[1].body).toEqual({ linkId: "l2", ttlHours: 8 });
  });
});

describe("what a support agent is told when the console refuses", () => {
  it("surfaces the reason a request was rejected instead of the status", async () => {
    respond = () => json(404, { error: "no patient with that address" });
    await expect(requestSupportAccess("nobody@example.com")).rejects.toThrow("no patient with that address");
  });

  it("keeps the status when a list endpoint fails with nothing to say", async () => {
    respond = () => new Response("", { status: 503 });
    await expect(listSupportOwners()).rejects.toThrow(/support owners failed \(503\)/);
  });

  it("throws on a revoked session mid-call rather than returning an empty console", async () => {
    // A 401 partway through the console's three loads must not read as "you have no patients".
    respond = () => json(401, { error: "your session has expired — sign in again" });
    await expect(listSupportProviders()).rejects.toThrow("sign in again");
  });
});
