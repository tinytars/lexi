import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic } from "./_synthetic";
import { clickNav } from "./_nav";
import { stubVaultSave } from "./_stubs";

// W62 — the two halves of the owner's vocabulary (2026-08-21), which a first cut of this milestone
// got wrong in one direction and then the other:
//
//   Translate     — LexiTar's reply to ONE turn. A user turn ALWAYS gets one. Ordinary app use.
//   Translate all — the whole-Finding regeneration. Provider-only, and what the ↻ menu item runs.
//
// Between them sits App's unprompted background sweep, which is neither: it fires a translation per
// stale node on load with nobody asking. That one stays provider-only.

/** Records every /api/leaf-regen attempt, and never lets one reach the real relay. */
function recordTranslates(page: Page) {
  const posted: string[] = [];
  page.route("**/api/leaf-regen", async (route) => {
    posted.push((route.request().postDataJSON() as { node?: string })?.node ?? "?");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: null }) });
  });
  return posted;
}

/** Keeps the write off the real vault, exactly like pin-persistence.spec.ts. */
// The regression this exists to prevent: gating every leaf translation on providerToken meant a
// patient could write a note and get silence back — no reply, no error, nothing.
test("a patient's own note gets its Translate", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await stubVaultSave(page);
  const posted = recordTranslates(page);

  // A synthetic patient, not a real pilot: this asserts a patient's note DOES get a Translate, and
  // `regen()` legitimately skips a leaf whose computed ancestors are stale. The real pilots' vaults
  // read stale on markerLevels/aiFindings, which would fail this test for a reason that has nothing
  // to do with the providerToken gate it exists to guard; the synthetic Finding ships fully computed.
  await openSynthetic(page);
  await clickNav(page, "Notes");
  await page.getByTitle("Add note").click();
  await page.locator(".nt-modal .note-input").fill(`W62 patient translate ${Date.now()}`);
  await page.locator(".nt-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".notes .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => posted, { timeout: 10_000 }).toContain("noteResults");
});

// The other direction, and the reason the gate exists at all: opening the app is not a request for
// anything. Nothing may fire until the user actually does something.
test("merely opening the app fires no Translate at all", async ({ page }) => {
  await stubVaultSave(page);
  const posted = recordTranslates(page);

  // A synthetic patient here too, and not merely for symmetry: on a stale vault every node is
  // skipped upstream, so "nothing fired" would hold even if the gate below were removed entirely.
  // The synthetic fixture is fresh enough for a Translate to be possible, which is what makes its
  // absence mean something.
  await openSynthetic(page);
  await clickNav(page, "Notes");
  await page.waitForTimeout(2500);

  expect(posted).toEqual([]);
});
