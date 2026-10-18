// W75 item 13 — the provider-grant half of auth-client.ts.
//
// auth-client.ts is 897 lines with 38 exports and had FOUR of them under test (23.86% lines / 12.5%
// branches), which is the wrong shape of gap: this is the browser side of every PHI-sharing decision
// the product makes, and its server counterparts are well covered — so the suite read green over a
// path where only the half that holds no secrets was verified.
//
// Split by domain rather than added to the one existing file, for the reason the file it was split
// from gives: a single growing auth-client.test.ts is how a 900-line module got four tested exports
// in the first place. This file is grants; support access and recovery/methods are their siblings.
//
// The fetch stub is a RECORDING PROXY, not a behavioural mock: every request body is kept verbatim so
// the assertions are about what actually went over the wire. The envelope tests then open the recorded
// envelope with the recipient's real private key — a shape assertion would pass on an envelope wrapped
// to the wrong person, which is precisely the bug that matters here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listMyProviders, lookupProvider, grantProvider, revokeProvider } from "@tinytars/vault/auth-grants";
import { approveSupport } from "@tinytars/vault/auth-support";
import { generateAccountKeypair, generateDEK, unwrapDEKWithPrivateKey, encryptVaultV2, decryptVaultV2 } from "@tinytars/vault/crypto";

const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

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

describe("granting a provider access", () => {
  it("sends an envelope only the named provider can open, and never the DEK itself", async () => {
    const provider = await generateAccountKeypair();
    const stranger = await generateAccountKeypair();
    const dek = await generateDEK();
    const sealed = await encryptVaultV2({ secret: "LDL 120" }, dek);

    await grantProvider(dek, { providerAccountId: "prov-1", publicKeyJwk: provider.publicKeyJwk });

    const [req] = sent;
    expect(req.url).toBe("/api/providers/grant");
    expect(req.body.providerAccountId).toBe("prov-1");
    expect(Object.keys(req.body).sort()).toEqual(["ephemeralPublicKeyJwk", "providerAccountId", "wrappedDEK"]);

    // The property, not the shape: the provider's own key opens it and yields the SAME DEK.
    const opened = await unwrapDEKWithPrivateKey(base64ToBytes(req.body.wrappedDEK), req.body.ephemeralPublicKeyJwk, provider.privateKey);
    expect(await decryptVaultV2(sealed, opened)).toEqual({ secret: "LDL 120" });

    // And nobody else's does.
    await expect(
      unwrapDEKWithPrivateKey(base64ToBytes(req.body.wrappedDEK), req.body.ephemeralPublicKeyJwk, stranger.privateKey),
    ).rejects.toThrow();
  });

  it("uses a fresh ephemeral key per grant, so two grants share nothing", async () => {
    const a = await generateAccountKeypair();
    const b = await generateAccountKeypair();
    const dek = await generateDEK();
    await grantProvider(dek, { providerAccountId: "a", publicKeyJwk: a.publicKeyJwk });
    await grantProvider(dek, { providerAccountId: "b", publicKeyJwk: b.publicKeyJwk });
    expect(sent[0].body.wrappedDEK).not.toBe(sent[1].body.wrappedDEK);
    expect(sent[0].body.ephemeralPublicKeyJwk).not.toEqual(sent[1].body.ephemeralPublicKeyJwk);
  });

  it("throws rather than resolving when the server refuses the grant", async () => {
    respond = () => json(403, { error: "this clinician already has access" });
    const p = await generateAccountKeypair();
    // W76 — the server's own sentence reaches the patient. It used to be replaced by "grant failed:
    // 403", which tells someone nothing about whether to retry, wait, or ask their clinician.
    await expect(grantProvider(await generateDEK(), { providerAccountId: "x", publicKeyJwk: p.publicKeyJwk })).rejects.toThrow(
      "this clinician already has access",
    );
  });
});

describe("revoking a provider", () => {
  it("DELETEs the link by id, escaping it into the path", async () => {
    await revokeProvider("link/with space");
    expect(sent[0]).toMatchObject({ url: "/api/providers/link%2Fwith%20space", method: "DELETE" });
  });

  it("throws on a failed revoke — a revocation that silently did nothing is the dangerous case", async () => {
    respond = () => json(500, {});
    await expect(revokeProvider("l1")).rejects.toThrow(/revoke failed \(500\)/);
  });
});

describe("looking a provider up by email", () => {
  it("returns null for the uniform 404 rather than throwing, so the UI can say 'no such provider'", async () => {
    respond = () => json(404, { error: "not found" });
    expect(await lookupProvider("nobody@example.com")).toBeNull();
  });

  it("encodes the address into the query string", async () => {
    respond = () => json(200, { providerAccountId: "p1", displayName: "Dr A", providerKind: "clinician", publicKeyJwk: {} });
    await lookupProvider("a+b@example.com");
    expect(sent[0].url).toBe("/api/providers/lookup?email=a%2Bb%40example.com");
  });

  it("throws on any other failure — an outage must not read as 'not registered'", async () => {
    respond = () => json(500, {});
    await expect(lookupProvider("a@example.com")).rejects.toThrow(/lookup failed \(500\)/);
  });
});

describe("listing providers", () => {
  it("unwraps the envelope object to the array the UI renders", async () => {
    respond = () => json(200, { providers: [{ id: "l1", providerAccountId: "p1" }] });
    expect(await listMyProviders()).toEqual([{ id: "l1", providerAccountId: "p1" }]);
    expect(sent[0].url).toBe("/api/providers");
  });
});

describe("approving a support request", () => {
  it("wraps the DEK to the AGENT's key and carries the time box the patient chose", async () => {
    const agent = await generateAccountKeypair();
    const dek = await generateDEK();
    const sealed = await encryptVaultV2({ v: 1 }, dek);

    await approveSupport("link-9", dek, agent.publicKeyJwk, 4);

    const [req] = sent;
    expect(req.url).toBe("/api/support/approve");
    expect(req.body.linkId).toBe("link-9");
    expect(req.body.ttlHours).toBe(4);
    const opened = await unwrapDEKWithPrivateKey(base64ToBytes(req.body.wrappedDEK), req.body.ephemeralPublicKeyJwk, agent.privateKey);
    expect(await decryptVaultV2(sealed, opened)).toEqual({ v: 1 });
  });
});

// W76 item 19 — the error branches. W75 asserted these three domains' happy paths; what stayed dark
// was every way they fail, which is the half a person only meets on a bad day.
describe("what a patient is told when a grant goes wrong", () => {
  it("shows the server's sentence rather than a number", async () => {
    respond = () => json(409, { error: "your session is out of date — reload and try again" });
    await expect(listMyProviders()).rejects.toThrow("your session is out of date — reload and try again");
  });

  it("still says which operation failed, and with what status, when the server sends no body at all", async () => {
    // A bare 502 from an edge outage has no `error` field. The fallback has to stay diagnosable
    // rather than collapsing to an empty message.
    respond = () => new Response("", { status: 502 });
    await expect(listMyProviders()).rejects.toThrow(/list providers failed \(502\)/);
  });

  it("does not mistake a body that is not JSON for a message", async () => {
    // Cloudflare's own error pages are HTML. Rendering that into the UI is how a JSON blob ends up
    // in front of a patient, which ai-error.ts refuses to do for the same reason.
    respond = () => new Response("<html>Error 1101</html>", { status: 500, headers: { "content-type": "text/html" } });
    await expect(listMyProviders()).rejects.toThrow(/list providers failed \(500\)/);
  });

  it("does not accept a whitespace-only error field as an explanation", async () => {
    respond = () => json(500, { error: "   " });
    await expect(listMyProviders()).rejects.toThrow(/list providers failed \(500\)/);
  });

  it("distinguishes a revoke that failed from one that did nothing", async () => {
    // A revocation reported as done but not performed is the dangerous direction: the patient
    // believes the clinician can no longer read the record.
    respond = () => json(500, { error: "could not revoke — the link is still active" });
    await expect(revokeProvider("l1")).rejects.toThrow("the link is still active");
  });
});
