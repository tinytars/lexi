import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openFreshSynthetic } from "./_synthetic";
import { clickNav } from "./_nav";
import { stubVaultSave } from "./_stubs";

// W62 — a user turn always gets its Translate; the unprompted on-open sweep stays provider-only.

function recordTranslates(page: Page) {
  const posted: string[] = [];
  page.route("**/api/leaf-regen", async (route) => {
    posted.push((route.request().postDataJSON() as { node?: string })?.node ?? "?");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: null }) });
  });
  return posted;
}

// The fresh patient opens every node stale, so a sweep would fire if the provider gate were gone.
test("a patient's own note gets its Translate, and opening the app fires nothing else", async ({ page }) => {
  await stubVaultSave(page);
  const posted = recordTranslates(page);

  await openFreshSynthetic(page);
  await clickNav(page, "Notes");
  await page.getByTitle("Add note").click();
  await page.locator(".nt-modal .note-input").fill(`W62 patient translate ${Date.now()}`);
  await page.locator(".nt-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".notes .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => posted, { timeout: 10_000 }).toContain("noteResults");
  expect(posted.filter((n) => n !== "noteResults")).toEqual([]);
});
