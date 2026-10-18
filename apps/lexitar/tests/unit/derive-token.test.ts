import { describe, it, expect } from "vitest";
import { deriveBearerToken } from "@tinytars/vault/crypto";

// Pins the derivation behind the deployed VAULT_TOKEN allowlist. The chat/raw bearers this
// originally covered are gone (requireSession; CHAT_TOKEN and RAW_TOKEN deleted 2026-08-26),
// but scripts/chat-allowlist.ts still builds VAULT_TOKEN from this same function — so a crypto
// change here would silently stop matching what scripts/vault-sync.ts sends to /api/vault.
describe("deriveBearerToken", () => {
  it("derives the pinned base64url(SHA-256) bearer per passphrase", async () => {
    expect(await deriveBearerToken("alex")).toBe("QTWqncG4QqZT3qhGkD3blb-4xaEMUEp_oW4QvDHR_fA");
    expect(await deriveBearerToken("blair")).toBe("tAn8zdc1VAW9Z6vpzR4fIYHn5yKJlFuIldwCOgkdgKw");
  });

  it("is url-safe (no +, /, or = padding)", async () => {
    const t = await deriveBearerToken("alex");
    expect(t).not.toMatch(/[+/=]/);
  });
});
