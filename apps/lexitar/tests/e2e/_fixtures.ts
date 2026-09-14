import { test as base, expect } from "@playwright/test";

export { expect };

// W76 — every spec runs with vault writes captured-and-replayed instead of reaching the dev server.
//
// This is not a preference about mocking; it is the only lever we have over a wrangler bug. A large
// PUT severed mid-body kills `wrangler pages dev` outright: its ProxyWorker raises "Network
// connection lost." and ProxyController treats it as fatal. Reproduced directly — 5 severed 472 KB
// PUTs kill the server, 60 COMPLETE ones do not. There is no server-side fix (cancelling the body on
// the Function's early-return paths was tried and does not help), and no wrangler release has it.
//
// Severing is not exotic: a test's context teardown aborts in-flight requests exactly as a reload
// does, so ANY test that ends over an unsettled whole-vault write is exposed. That is why this is a
// suite-wide fixture rather than a per-spec call — `search-content`, `permalink` and `notes` each
// killed a CI shard without sharing any pattern except writing and then ending.
//
// Waiting for `.saved` is NOT cover: saves are chained and `saved` flips on EVERY success, so the
// assertion can be satisfied by an earlier write while a later one is still streaming.
//
// What this costs, stated plainly: a reload assertion still proves the client sent the right bytes
// and re-renders them, but no longer proves the SERVER persisted them. That trade is only acceptable
// because no spec asserts server-side storage directly — none reference etag, If-Match, 412 or 428.
// If you write one that does, give it its own un-intercepted page rather than weakening this.
//
// Two specs are excluded for exactly that reason and import `test` from @playwright/test directly:
// providers-access and providers-support. Both revoke access, which re-keys the vault, and both then
// assert that a FRESH login still opens it — a claim only the server can answer. They are safe
// un-intercepted because they run on fresh signups, whose vaults are small; only a large body can be
// caught mid-stream. The list is two rather than the three first guessed: `support-provider-roster`
// only looked similar, and the sibling-route bug below was what had actually broken it.
//
// Routed on `context`, not `page`, so a second page opened by a spec is covered too. A spec's own
// `page.route` still wins — page routes are matched before context routes.
// `**/api/vault/*` also matches the SIBLING routes under functions/api/vault/ — they are not vault
// blobs and must reach the server, or the flows built on them (recovery, access grants, re-key) break
// in ways that look like product bugs. Answering their PUTs 204 is what broke recovery.spec.ts.
const SIBLING_ROUTES = new Set(["org-key", "principals", "recovery-envelope", "rotate"]);

export const test = base.extend<{ vaultGuard: void }>({
  vaultGuard: [
    async ({ context }, use) => {
      const captured = new Map<string, Buffer>();
      await context.route("**/api/vault/*", (route) => {
        const request = route.request();
        const id = new URL(request.url()).pathname.split("/").pop() ?? "";
        if (SIBLING_ROUTES.has(id)) return route.fallback();
        if (request.method() === "PUT") {
          const body = request.postDataBuffer();
          if (body) captured.set(id, body);
          return route.fulfill({ status: 204, body: "" });
        }
        const hit = captured.get(id);
        return hit
          ? route.fulfill({ status: 200, contentType: "application/octet-stream", body: hit })
          : route.fallback();
      });
      // W76 — the second source of severed in-flight requests, found by reading the wrangler log of a
      // shard that still died AFTER vault writes were intercepted: bursts of background
      // /api/leaf-regen POSTs, unanswered when a test ends. Both crashes in run 33067014364 carry the
      // same signature — three or four `"route":"/api/leaf-regen","status":502` lines, then
      // ProxyController's "Network connection lost." 0.4s later. `shell-study-hypothesis` stubs
      // leaf-regen only inside its :57 test, and :128/:158/:194 — the three with no stub — are exactly
      // the three that died.
      //
      // This is NOT a mock of a working backend. CI holds no RANGES_ANTHROPIC_API_KEY, so the real
      // route already 502s `anthropic_error` on every call, in 3-45ms; the stub returns byte-identical
      // what the server returns, and removes only the trip across the wire. A spec whose SUBJECT is
      // leaf-regen registers its own `page.route`, and page routes are matched before context routes,
      // so all thirteen existing handlers keep winning untouched.
      await context.route("**/api/leaf-regen", (route) =>
        route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "leaf-regen backend error", errorCode: "anthropic_error" }),
        }),
      );
      // W76 — the THIRD source, and the same shape again: attachment blobs. Pablo's vault references
      // real medication-label photos that live only in the deployed R2, so every <img> fires a GET
      // that 404s. They arrive in bursts of four to eight as a cover renders, nothing awaits them, and
      // a test that ends promptly ends over several. Measured across the shard-2 and shard-9 logs:
      // 166 requests to /api/raw, 404 every single time, not one 200 — this environment structurally
      // cannot have those blobs, and seeding them would mean copying PHI onto a CI runner.
      //
      // Only GET is answered. A PUT is a real upload that import.spec.ts asserts on, and those specs
      // route it themselves anyway; falling through keeps that path honest.
      await context.route("**/api/raw/**", (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              status: 404,
              contentType: "application/json",
              body: JSON.stringify({ error: "raw source not found" }),
            })
          : route.fallback(),
      );
      // W76 — the third always-failing route, included on the RULE rather than on direct evidence: it
      // never appeared immediately before a crash, but it is background, unawaited, and 404s on all 40
      // calls in the shard logs, which is the same shape as the two above. Capture-and-replay rather
      // than a blanket 404, so a spec that writes history and reads it back still sees its own bytes —
      // `interceptChatHistory` in _stubs.ts is the page-level version, and keeps winning where used.
      const history = new Map<string, Buffer>();
      await context.route("**/api/chat-history/**", (route) => {
        const request = route.request();
        const id = new URL(request.url()).pathname.split("/").pop() ?? "";
        if (request.method() === "PUT") {
          const body = request.postDataBuffer();
          if (body) history.set(id, body);
          return route.fulfill({ status: 204, body: "" });
        }
        const hit = history.get(id);
        return hit
          ? route.fulfill({ status: 200, contentType: "application/octet-stream", body: hit })
          : route.fulfill({
              status: 404,
              contentType: "application/json",
              body: JSON.stringify({ error: "not found" }),
            });
      });
      await use();
    },
    { auto: true },
  ],
});
