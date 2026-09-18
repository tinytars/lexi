import { test, expect } from "./_fixtures";
import { openSynthetic, openSyntheticAsProvider } from "./_synthetic";
import { clickLeafMenuItem, openLeafMenu } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { watchFlashes, expectFlashed } from "./_flash";
import { gotoTreatmentBucket, identifyTreatmentByText, addOngoingTreatment, editFirstDoseEntry } from "./_shell";

// The Treatment section's own views and editing — the unified temporal buckets, the Add/Edit modal,
// which bucket survives a reload, the two extractors (From text, From photos), and what the dose
// conclusion is allowed to claim.
//
// What is NOT here: anything asserting that an edit fires an /api/leaf-regen trigger. Those are in
// `shell-leaf-regen`, because what they exercise is the relay, not the Treatment UI.
//
// W74 — one of the seven files `shell-nav.spec.ts` became. It was 1437 lines and 53 tests, and
// `--shard` partitions by FILE: whichever shard held it ran ~56 tests against a single workerd while
// every other shard ran 19, which made it the gate's chronic red. Helpers shared by more than one of
// the seven live in `_shell.ts`; a helper with one caller stayed with its caller.

test("Patient → Treatment: unified temporal sets + the AI's per-treatment assessment (W31)", async ({ page }) => {
  const who = await openSynthetic(page);
  await clickNav(page, "Treatment");
  // Patient regimen (left) beside the AI's assessment (right), all under the one unified section.
  await expect(page.locator(".unified-treatment .persona-bubble.p-owner").first()).toBeVisible();
  await expect(page.locator(".unified-treatment .persona-bubble.p-assistant").first()).toBeVisible();
  // All is the sidebar's default bucket on bare arrival — its per-drug history renders without a
  // click, ahead of the Ongoing/Planned/Past buckets. (It replaced the old flat "Ungrouped" row,
  // which listed the same treatments with no dose history.)
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "All" })).toHaveClass(/active/);
  await expect(page.locator(".unified-treatment")).toContainText(`Rosuvastatin ${who.tag}`);
  // The Ongoing set carries the current regimen (the fixture's Rosuvastatin has a start date and no end).
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Ongoing" }).click();
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "Ongoing" })).toHaveClass(/active/);
  await expect(page.locator(".unified-treatment")).toContainText(`Rosuvastatin ${who.tag}`);
  // The fixture's future-dated Ezetimibe surfaces as the Planned set — only one bucket renders at
  // a time now, so select it from the sidebar's lower zone first.
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Planned" }).click();
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "Planned" })).toHaveClass(/active/);
});

// M111 — the remembered-submenu effect (App.svelte) ran on the very first reactive pass after a
// hash-link boot, before selectedClientId had resolved through the async vault-unlock chain,
// defaulting every group-bearing section straight to its own default and never revisiting it once the
// real clientId arrived. A page reload is the only way to exercise that boot race — a same-tab
// click through `unlock`/`clickNav` never hits it.
test("a selected Treatment submenu survives a page reload, not just the default (M111)", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Treatment");
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Ongoing" }).click();
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "Ongoing" })).toHaveClass(/active/);

  await page.reload();
  await page.waitForSelector(".sidebar .nav-item");
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "Ongoing" })).toHaveClass(/active/, { timeout: 10_000 });
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "All" })).not.toHaveClass(/active/);
});

test("Patient (provider): Treatment edit opens the Add modal pre-filled; Reports carry a delete (W34/M66)", async ({ page }) => {
  await openSyntheticAsProvider(page);

  // M66 — Treatment default is a read view with a ✎ that opens the same Add modal, pre-filled —
  // no more in-context field reveal on the row itself.
  await clickNav(page, "Treatment");
  await gotoTreatmentBucket(page, "Ongoing");
  await expect(page.locator(".unified-treatment .persona-bubble.p-owner").first()).toBeVisible();
  // The only input present before editing is the M52 view filter — the raw treatment fields live in the modal.
  await expect(page.locator(".unified-treatment input:not(.filter)")).toHaveCount(0);
  await editFirstDoseEntry(page);
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Edit dose entry");
  await expect(page.locator(".tedit input[type=text]").first()).toBeVisible();
  await page.locator(".tedit-actions .btn", { hasText: "Cancel" }).click();

  // Reports: Delete is a menu item (M66 P3/M71), no longer gated behind opening ✎ first.
  // M62 — Reports moved to the Labs tab.
  await clickNav(page, "Reports");
  const reportRow = page.locator(".health-reports .leaf-card").filter({ has: page.locator(".leaf-menu-trigger") }).first();
  // Scope the click to the leaf-card's own header row (not a nested per-diagnosis one — M72 gave
  // diagnosis rows their own Pin-only menu too, so `.leaf-menu-trigger` is not unique within the
  // whole leaf-card).
  // W46 Phase 1 — the panel is portaled to <body>, no longer a descendant of `reportRow`.
  await openLeafMenu(reportRow.locator(".leaf-card-head"));
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
});

test("Treatment: after Add/Save the page scrolls to and flashes the new item (M66 P8)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M66 flash rx ${Date.now()}`;

  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await watchFlashes(page);
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();

  const row = page.locator(".unified-treatment .leaf-card", { hasText: marker });
  const anchorId = await row.locator(".permalink-heading").first().getAttribute("id");
  // anchor.ts's flashAnchor scrolls-into-view + rings the exact element it resolved (M66 P4/P7's
  // onSaved(treatmentAnchor(name)) call) — assert the flash lands on that same element, not just
  // that the row exists somewhere on the page.
  await expectFlashed(page, anchorId);
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // Clean up — delete the throwaway treatment so repeat runs don't accumulate.
  await clickLeafMenuItem(row, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// Editing must leave you where you were looking. The post-save anchor resolves the bucket of the
// medicine's REPRESENTATIVE row, so saving from Past threw you into Ongoing whenever that drug also
// had a current dose period — the reassignment belongs to navigation, not to saving. The medicine
// therefore needs BOTH a past and an ongoing row, or the assertion passes without the fix.
test("Treatment: saving an edit from the Past view stays in Past, even when the drug is also ongoing", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-past-stay ${Date.now()}`;
  await addOngoingTreatment(page, marker);
  // A second, already-finished dose period of the same drug — groups with the first by name.
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2019-01-01");
  await page.locator(".tedit-daterow .field", { hasText: "End" }).locator("input").fill("2019-06-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "Past");
  const group = page.locator(".med-group", { hasText: marker });
  await group.locator(".med-table td.med-actions .btn", { hasText: "Edit" }).first().click();
  await page.locator(".tedit .field", { hasText: "Amount" }).locator("input").fill(String(Date.now() % 100000));
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await page.waitForTimeout(1000);
  await expect(page.locator(".sidebar .group-list .sub-item.active")).toHaveText(/Past/);

  await gotoTreatmentBucket(page, "All");
  await clickLeafMenuItem(page.locator(".unified-treatment .leaf-card", { hasText: marker }), "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// M-reason-in-dose-editor — Reason moved out of the medicine-scope form into the entry/dose editor,
// but stays a medicine-level fact by convention: saving it from one dose row's entry-scope edit must
// fan out to every sibling row of the same drug, exactly like Name/Kind/product fields already fan
// out from the medicine-scope form. Editing it on the Past row and then reading it back off the
// Ongoing row (a genuinely different row, in a different bucket) is what proves the fan-out actually
// happened, rather than just the one row that was edited.
test("Treatment: setting Reason on one dose row fans it out to sibling rows of the same drug (M-reason-in-dose-editor)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-reason-fanout ${Date.now()}`;
  await addOngoingTreatment(page, marker);
  // A second, already-finished dose period of the same drug — groups with the first by name.
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2019-01-01");
  await page.locator(".tedit-daterow .field", { hasText: "End" }).locator("input").fill("2019-06-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  const reason = `joint pain, fanout check ${Date.now()}`;
  await gotoTreatmentBucket(page, "Past");
  const pastGroup = page.locator(".med-group", { hasText: marker });
  await pastGroup.locator(".med-table td.med-actions .btn", { hasText: "Edit" }).first().click();
  await page.locator(".tedit .field", { hasText: "Reason" }).locator("input").fill(reason);
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // Read it back off the Ongoing row — a different physical row than the one just edited.
  await gotoTreatmentBucket(page, "Ongoing");
  await expect(page.locator(".med-group", { hasText: marker })).toContainText(reason);

  await gotoTreatmentBucket(page, "All");
  await clickLeafMenuItem(page.locator(".unified-treatment .leaf-card", { hasText: marker }), "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});
