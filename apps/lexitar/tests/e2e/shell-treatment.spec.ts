import { test, expect } from "./_fixtures";
import { openSynthetic, openSyntheticAsProvider } from "./_synthetic";
import { openLeafMenu } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { watchFlashes, expectFlashed } from "./_flash";
import { gotoTreatmentBucket, identifyTreatmentByText, addOngoingTreatment, editFirstDoseEntry } from "./_shell";
import type { Page } from "@playwright/test";

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
  // The flash must land on the exact element the save resolved, not merely somewhere on the page.
  await expectFlashed(page, anchorId);
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });
});

// A second (or third) dose period of a drug that already exists — repeated names are how a titration
// is recorded, so these group under the one card by name. `addOngoingTreatment` covers the open-ended
// case; this covers a closed one and a future-dated one, which four tests below need.
async function addDosePeriod(page: Page, name: string, start: string, end?: string) {
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name, kind: "drug" });
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("1");
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill(start);
  if (end) await page.locator(".tedit-daterow .field", { hasText: "End" }).locator("input").fill(end);
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });
}

// Editing must leave you where you were looking — and after the filters became per-drug, where you
// were looking is a filter the drug IS in. The old version of this test ("saving an edit from the Past
// view stays in Past, even when the drug is also ongoing") pinned the workaround for the defect: a
// drug sat in Past and in Ongoing at once, the post-save anchor resolved one representative dose row,
// and a save from Past threw you into Ongoing. Under a partition that premise cannot be built, and a
// "stays put" assertion can no longer fail. What can fail is the other half of the same guarantee: an
// edit that MOVES the drug to another filter has to take the view with it, or you are left facing a
// list the thing you just edited is absent from.
test("Treatment: ending the only ongoing dose period follows the card from Ongoing to Past", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-follow-to-past ${Date.now()}`;
  await addOngoingTreatment(page, marker);

  await gotoTreatmentBucket(page, "Ongoing");
  const group = page.locator(".med-group", { hasText: marker });
  const anchorId = await group.locator(".permalink-heading").first().getAttribute("id");
  await group.locator(".med-table td.med-actions .btn", { hasText: "Edit" }).first().click();
  // Closing out its one and only dose period: the drug has no current and no future period left, so
  // groupBucket moves it from ongoing to past.
  await page.locator(".tedit-daterow .field", { hasText: "End" }).locator("input").fill("2021-06-01");
  await watchFlashes(page);
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // The anchor flash is the last step of the navigation, and the card it lands on is in Past.
  await expectFlashed(page, anchorId);
  await expect(page.locator(".sidebar .group-list .sub-item.active")).toHaveText(/Past/);
  await expect(page.locator(".med-group", { hasText: marker })).toBeVisible();
});

// M-reason-in-dose-editor — Reason moved out of the medicine-scope form into the entry/dose editor,
// but stays a medicine-level fact by convention: saving it from one dose row's entry-scope edit must
// fan out to every sibling row of the same drug, exactly like Name/Kind/product fields already fan
// out from the medicine-scope form.
//
// The original read it back off the same drug's card in a DIFFERENT bucket, which a partition makes
// impossible — and worse, it would now pass without the fan-out: one card carries all of the drug's
// rows and `.med-reason` answers from whichever row has one. So the read-back goes through the thing
// that is still per-row: expand the Ongoing card, edit Reason on the greyed past row, then open the
// ONGOING row's own entry editor and find it pre-filled. Same proof, a genuinely different physical
// row, and it fails if the fan-out is removed.
test("Treatment: setting Reason on one dose row fans it out to sibling rows of the same drug (M-reason-in-dose-editor)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-reason-fanout ${Date.now()}`;
  await addOngoingTreatment(page, marker);
  await addDosePeriod(page, marker, "2019-01-01", "2019-06-01");

  const reason = `joint pain, fanout check ${Date.now()}`;
  await gotoTreatmentBucket(page, "Ongoing");
  const group = page.locator(".med-group", { hasText: marker });
  // The past dose period is not in this view's bucket, so it is behind the toggle.
  await group.locator(".med-more").click();
  const pastRow = group.locator(".med-table tbody tr.med-out");
  await expect(pastRow).toHaveCount(1);
  await pastRow.locator("td.med-actions .btn", { hasText: "Edit" }).click();
  await page.locator(".tedit .field", { hasText: "Reason" }).locator("input").fill(reason);
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // Read it back off the ongoing row's own editor — the row that was NOT edited.
  await page
    .locator(".med-group", { hasText: marker })
    .locator(".med-table tbody tr:not(.med-out):not(.med-flag) td.med-actions .btn", { hasText: "Edit" })
    .first()
    .click();
  await expect(page.locator(".tedit .field", { hasText: "Reason" }).locator("input")).toHaveValue(reason);
});

// Invariant I1 in the browser: the three temporal filters partition the drugs, so a titrated drug —
// a past dose period, a current one and a scheduled increase, all under one name — is in exactly one
// of them. Before this it was in all three at once: Past because a step had ended, Planned because a
// step was scheduled, Ongoing because it is being taken. All stays the unfiltered list (I2), so the
// same drug is there too, with every one of its dose periods on the card.
test("Treatment: a titrated drug is in exactly one temporal filter, and in All with its whole history", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-one-bucket ${Date.now()}`;
  await addOngoingTreatment(page, marker); // a current dose period
  await addDosePeriod(page, marker, "2019-01-01", "2019-06-01"); // a finished one
  await addDosePeriod(page, marker, "2099-01-01"); // a scheduled increase

  const card = page.locator(".med-group", { hasText: marker });
  await gotoTreatmentBucket(page, "Ongoing");
  await expect(card).toHaveCount(1);
  await gotoTreatmentBucket(page, "Planned");
  await expect(card).toHaveCount(0);
  await gotoTreatmentBucket(page, "Past");
  await expect(card).toHaveCount(0);

  await gotoTreatmentBucket(page, "All");
  await expect(card).toHaveCount(1);
  // All three dose periods, no toggle needed — the drug's whole history, which is what makes the
  // three filters a partition OF All rather than a fourth bucket beside it.
  await expect(card.locator(".med-table tbody tr:not(.med-flag)")).toHaveCount(3);
  await expect(card).toContainText("2019");
  await expect(card).toContainText("2099");
});

// The other half of the same change: a filter no longer truncates a drug's timeline. Its own dose
// periods show collapsed, and one click reveals the rest, marked as history rather than hidden —
// which is what the old Ongoing view had no way to show at all.
test("Treatment: expanding an Ongoing card reveals its past dose period, greyed and pilled", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-show-history ${Date.now()}`;
  await addOngoingTreatment(page, marker);
  await addDosePeriod(page, marker, "2019-01-01", "2019-06-01");

  await gotoTreatmentBucket(page, "Ongoing");
  const card = page.locator(".med-group", { hasText: marker });
  // Collapsed: this bucket's one row, and a toggle counting the drug's total.
  await expect(card.locator(".med-table tbody tr:not(.med-flag)")).toHaveCount(1);
  await expect(card.locator(".med-table tbody tr.med-out")).toHaveCount(0);
  const toggle = card.locator(".med-more");
  await expect(toggle).toHaveText(/Show full history \(2\)/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  const pastRow = card.locator(".med-table tbody tr.med-out");
  await expect(pastRow).toHaveCount(1);
  await expect(pastRow.locator(".bucket.bucket--past")).toBeVisible();
  await expect(pastRow).toContainText("2019");
  await expect(toggle).toHaveText(/Show fewer/);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});
