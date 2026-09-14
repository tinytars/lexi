import { test, expect } from "./_fixtures";
import { openSynthetic } from "./_synthetic";
import { clickNav } from "./_nav";

// W70 Phase 2 — Modal is a native <dialog> now, and it asks before discarding unsaved work.
//
// Everything here is browser behaviour that no unit test can see: focus trapping, per-dialog Escape,
// and whether a backdrop press actually closes. It drives the WORKER'S OWN synthetic patient, so it
// needs no credential and cannot disturb the pilots.
//
// What was broken before, at all 15 call sites:
//   • The backdrop closed on ANY click, with no dirty check, so a patient composing a long free-text
//     note lost all of it to one mis-aimed click.
//   • `<svelte:window onkeydown>` meant Escape closed EVERY mounted Modal at once, not the top one.
//   • Nothing ever focused the panel, while `aria-modal="true"` told a screen reader the background
//     was inert — a keyboard user could Tab straight into it.

/**
 * Press the backdrop.
 *
 * With a native <dialog>, the backdrop is `::backdrop` — a pseudo-element that is NOT part of the
 * dialog's box, so an element-relative click lands INSIDE the panel and never reaches it. A viewport
 * coordinate outside the panel is the only way to hit it; the browser dispatches that press to the
 * <dialog> element itself, which is what the component listens for.
 */
async function pressBackdrop(page: import("@playwright/test").Page) {
  const box = (await page.locator("dialog.modal-panel").boundingBox())!;
  const y = Math.max(4, box.y / 2); // above the panel: it is margin-offset from the top
  await page.mouse.move(box.x / 2, y);
  await page.mouse.down();
  await page.mouse.up();
}

async function openAddNote(page: import("@playwright/test").Page) {
  await openSynthetic(page);
  await clickNav(page, "Notes");
  await page.getByTitle("Add note").click();
  await expect(page.locator("dialog.modal-panel")).toHaveAttribute("aria-label", "Add note");
}

test("an untouched modal closes on a backdrop click, as it always did", async ({ page }) => {
  await openAddNote(page);
  await pressBackdrop(page);
  await expect(page.locator("dialog.modal-panel")).toHaveCount(0);
});

test("a backdrop click on a HALF-TYPED note asks instead of discarding it", async ({ page }) => {
  await openAddNote(page);
  await page.locator(".nt-modal .note-input").fill("a long thought I do not want to lose");

  await pressBackdrop(page);

  // The note modal is still open, and a confirmation is on top of it.
  await expect(page.locator("dialog.discard-confirm")).toBeVisible();
  await expect(page.locator("dialog.modal-panel")).toHaveCount(1);

  await page.locator("dialog.discard-confirm .btn", { hasText: "Keep editing" }).click();
  await expect(page.locator("dialog.discard-confirm")).toBeHidden();
  // And the words are still there — the whole point.
  await expect(page.locator(".nt-modal .note-input")).toHaveValue("a long thought I do not want to lose");
});

test("Escape on a half-typed note asks too, and Discard really discards", async ({ page }) => {
  await openAddNote(page);
  await page.locator(".nt-modal .note-input").fill("typed then escaped");

  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.discard-confirm")).toBeVisible();

  await page.locator("dialog.discard-confirm .btn", { hasText: "Discard" }).click();
  await expect(page.locator("dialog.modal-panel")).toHaveCount(0);
});

// The reason for <dialog>: showModal() traps focus and makes the background inert. Previously nothing
// focused the panel at all, so a keyboard user tabbed straight through to the page behind it.
test("focus is inside the dialog, and Tab does not escape to the page behind it", async ({ page }) => {
  await openAddNote(page);
  const inDialog = () =>
    page.evaluate(() => {
      const d = document.querySelector("dialog.modal-panel");
      return !!(d && document.activeElement && d.contains(document.activeElement));
    });
  expect(await inDialog()).toBe(true);
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  expect(await inDialog()).toBe(true);
});

// NOTE on what is deliberately NOT asserted here: "the background is inert". The obvious check —
// elementFromPoint over a sidebar button — is unreliable, because `::backdrop` is a pseudo-element and
// is never returned by elementFromPoint, so the assertion can pass whether or not the background is
// actually inert. A test that passes for the wrong reason is worse than no test. The focus-containment
// case above already demonstrates the property that matters to a keyboard user: Tab cannot leave.
