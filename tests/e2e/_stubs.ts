import type { Page } from "@playwright/test";

// G1 — these two used to route `**/api/vault/pablo` by name. That silently did nothing for any other
// client, which is the W64 trap again: a stub that cannot fire reads exactly like one that did. The
// blob route is the only PUT under /api/vault (rotate, org-key, principals and recovery-envelope are
// GET/POST/DELETE), so matching the id segment is precise, not a widening.
export const VAULT_BLOB = "**/api/vault/*";

// The network stubs the specs share, in one place — the fourth `_`-prefixed helper module alongside
// _login, _nav and _leaf-menu.
//
// W64 — before this, the chat-history stub existed 12 times across 9 files, the vault-save capture
// 3 times byte-identical, and the plain vault-save stub 3 more. Each store has exactly two useful
// behaviours — forget the write, or capture and replay it — so there are four functions here and no
// fifth name for an existing one (cover-render's `stubEmptyChatHistory` was a one-line alias).

/**
 * No chat history on file: PUT accepted, GET answers an empty blob.
 *
 * Without it, first load logs a console.error from a chat-history 404 — which matters because
 * several specs assert on a clean console.
 */
export async function stubChatHistory(page: Page) {
  await page.route("**/api/chat-history/**", (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.alloc(0) });
  });
}

/**
 * Accept every vault write and forget it. For specs that exercise an in-memory interaction and must
 * not touch the shared Pablo fixture.
 */
export async function stubVaultSave(page: Page) {
  await page.route(VAULT_BLOB, (route) =>
    route.request().method() === "PUT" ? route.fulfill({ status: 204, body: "" }) : route.continue(),
  );
}

/**
 * Capture the vault write and replay it on the next GET, so a reload sees what was saved without it
 * reaching the real store. Returns a predicate: did a PUT actually happen?
 *
 * This is the one to use when a spec reloads and asserts persistence; stubVaultSave above would let
 * the reload read the ORIGINAL vault and quietly assert nothing.
 */
export function interceptVaultSave(page: Page): () => boolean {
  let captured: Buffer | null = null;
  let capturedUrl = "";
  page.route(VAULT_BLOB, (route) => {
    const url = route.request().url();
    if (route.request().method() === "PUT") {
      captured = route.request().postDataBuffer();
      capturedUrl = url;
      return route.fulfill({ status: 204, body: "" });
    }
    // Replay only the vault that was written — the URL is part of the identity, so a GET for a
    // different client (or a sibling route) must still reach the server.
    if (captured && url === capturedUrl)
      return route.fulfill({ status: 200, contentType: "application/octet-stream", body: captured });
    return route.continue();
  });
  return () => captured !== null;
}

/**
 * Chat history that survives a reload: capture the PUT, replay it on GET. The chat counterpart of
 * interceptVaultSave, and the only variant a persistence assertion can use.
 */
export async function interceptChatHistory(page: Page) {
  let captured: Buffer | null = null;
  await page.route("**/api/chat-history/**", (route) => {
    if (route.request().method() === "PUT") {
      captured = route.request().postDataBuffer();
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({ status: 200, contentType: "application/octet-stream", body: captured ?? Buffer.alloc(0) });
  });
  return () => captured;
}
