import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openAsProvider, openPatient } from "./_login";

// W15/3b.2 — provider-only Finding refresh wiring. The provider fetches PROVIDER_TOKEN on unlock,
// sees a "Translate" button (W41), and clicking it streams from /api/refresh-finding with that
// token. A patient's own session never sees the button. (The happy-path assembly is covered by the
// finding unit tests + a live prod smoke; here we drive the wiring with a deterministic error stream.)

async function providerInto(page: Page, patient: string) {
  await openAsProvider(page, patient);
}

test("a patient's own session has no Translate control", async ({ page }) => {
  await page.route("**/api/provider-token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "t" }) }));
  await openPatient(page);
  await expect(page.getByRole("button", { name: /Translate/ })).toHaveCount(0);
});

test("the idle Translate button's tooltip shows the last successful translation time (W41)", async ({ page }) => {
  await page.route("**/api/provider-token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "provtok-123" }) }));
  await providerInto(page, "Pablo");
  await page.locator(".account-trigger").click();
  const item = page.getByRole("menuitem", { name: /Translate/ });
  await expect(item).toBeVisible();
  // Pablo's vault carries a generated Translation, so the hover reports when it last succeeded.
  await expect(item).toHaveAttribute("title", /^Last translated .+ · Regenerate this patient's Translation/);
});

test("provider clicks Translate → streams with the provider token → surfaces a stream error", async ({ page }) => {
  await page.route("**/api/provider-token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "provtok-123" }) }));

  let sawToken = "";
  let sawClient = false;
  await page.route("**/api/refresh-finding", (route) => {
    const req = route.request();
    sawToken = req.headers()["authorization"] ?? "";
    sawClient = (req.postData() ?? "").includes('"client"');
    // In-band terminal error sentinel — deterministic, one call, no retry.
    route.fulfill({ status: 200, contentType: "text/plain", body: "\n[[REFRESH_ERROR]] test generation failure" });
  });

  await providerInto(page, "Pablo");
  await page.locator(".account-trigger").click();
  const item = page.getByRole("menuitem", { name: /Translate/ });
  await expect(item).toBeVisible();
  await item.click();

  await expect(page.getByRole("button", { name: /translation failed/ })).toBeVisible({ timeout: 10_000 });
  expect(sawToken).toBe("Bearer provtok-123");
  expect(sawClient).toBe(true);
});

test("provider opens Diagnostics and sees the persisted refresh events with token counts", async ({ page }) => {
  await page.route("**/api/provider-token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "provtok-123" }) }));
  let sawLogsToken = "";
  await page.route("**/api/logs**", (route) => {
    sawLogsToken = route.request().headers()["authorization"] ?? "";
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: [
          { at: "2026-07-05T10:00:00.000Z", route: "/api/refresh-finding", status: 200, event: "stream-done", attempt: 1, chars: 42000, usage: { input: 4200, output: 9100 }, latencyMs: 61000 },
          { at: "2026-07-05T09:59:00.000Z", route: "/api/refresh-finding", status: 200, event: "accepted", attempt: 1 },
        ],
      }),
    });
  });

  await providerInto(page, "Pablo");
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: "Diagnostics" }).click();

  const row = page.locator(".diag-table tbody tr").first();
  await expect(row.locator(".ev-stream-done")).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("4.2k / 9.1k"); // token cost is visible
  await expect(row).toContainText("61.0s");
  expect(sawLogsToken).toBe("Bearer provtok-123");
});

test("refresh shows a progress bar while generating, with no attempt/portion count surfaced (W41)", async ({ page }) => {
  await page.route("**/api/provider-token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "provtok-123" }) }));

  // Valid JSON (so it parses — not classified truncated) but a structurally-incomplete Finding, so
  // validateFindingWithInputs fails every attempt → the client retries with a correction, capped at 3.
  // The small delay holds each attempt's "generating" state long enough to observe the progress bar.
  await page.route("**/api/refresh-finding", async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    route.fulfill({ status: 200, contentType: "text/plain", body: '{"progression":{"latest":"","recent":"","overall":""}}' });
  });

  await providerInto(page, "Pablo");
  await page.locator(".account-trigger").click();
  await page.getByRole("menuitem", { name: /Translate/ }).click();

  // The progress bar is the only progress affordance — the retry/portion counts are never shown.
  // M62 — the in-flight indicator is now a non-interactive .refresh-status span (was .refresh-btn).
  const status = page.locator(".refresh-status");
  await expect(status).toBeVisible();
  await expect(status.locator(".refresh-bar")).toBeVisible({ timeout: 10_000 });
  await expect(status).not.toContainText(/try /);

  await expect(page.getByRole("button", { name: /translation failed/ })).toBeVisible({ timeout: 10_000 });
});
