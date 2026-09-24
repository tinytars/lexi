import { test, expect } from "./_fixtures";
import { openFreshSyntheticAsProvider } from "./_synthetic";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The two UNPROMPTED callers used to eat a 402 and keep asking, so the only sign an account had run
// dry was a console line nobody reads — and the patient's next question then failed with no warning.
// ai-availability.svelte.ts both raises the badge and halts the loops; this pins the pair end to end.

// The e2e runner's loader cannot take model-config.ts's JSON import, so the same one-line lookup
// (model-config.ts:156) is made here against the one config file both sides read.
const config = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "inference.config.json"), "utf8"),
) as { providers: Record<string, { billingUrl?: string }>; features: Record<string, { provider: string }> };
const BILLING_URL = config.providers[config.features.chat.provider].billingUrl!;

const OUT_OF_CREDIT = {
  status: 402,
  contentType: "application/json",
  body: JSON.stringify({ error: "AI is temporarily unavailable: the account is out of credits.", errorCode: "insufficient_credit" }),
};

test("a 402 raises the sidebar credit badge, links the billing console, and halts the background sweep", async ({ page }) => {
  let posts = 0;
  await page.route("**/api/leaf-regen", async (route) => {
    posts++;
    await route.fulfill(OUT_OF_CREDIT);
  });

  await openFreshSyntheticAsProvider(page);

  const badge = page.locator('[data-testid="ai-credit-badge"]');
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await expect(badge).toHaveText(/no credit/i);
  await expect(badge).toHaveAttribute("href", BILLING_URL);

  // The fresh patient opens with every node stale, so an ungated sweep posts all six. What lands
  // instead is one call per presence signal: the sweep's first node, plus at most the one the
  // record-opened signal re-arms after it — the signal arrives while the sweep is already running.
  await page.waitForTimeout(3_000);
  expect(posts).toBeLessThanOrEqual(2);

  // And then it is quiet. Nothing re-arms on its own, which is the whole point: a refused call is
  // refused until a human tops the account up.
  const settled = posts;
  await page.waitForTimeout(3_000);
  expect(posts).toBe(settled);
});
