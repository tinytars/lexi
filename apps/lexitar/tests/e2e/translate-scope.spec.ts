import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic, openFreshSynthetic } from "./_synthetic";
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
  // `regen()` skips any leaf that isn't in the stale set. A DEFAULT synthetic patient has
  // `nodeHashes` unset, which makes staleNodes() return an empty set — nothing regens at all. The
  // fresh synthetic patient sets `nodeHashes: {}`, so noteResults reads as drifted and can fire.
  await openFreshSynthetic(page);
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

  // A default (non-fresh) synthetic patient here, deliberately not the fresh one: its `nodeHashes`
  // is unset, so nothing reads as stale and no leaf could regen even if the gate below were removed
  // — a weaker assertion than the fresh case would give. That's fine for THIS test, which only
  // claims that opening the app requests nothing on its own; it isn't the one proving a Translate
  // is possible at all (the previous test, on the fresh patient, is).
  await openSynthetic(page);
  await clickNav(page, "Notes");
  await page.waitForTimeout(2500);

  expect(posted).toEqual([]);
});
