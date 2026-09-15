import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openAsProvider } from "./_login";
import { clickLeafMenuItem } from "./_leaf-menu";
import { watchFlashes, expectFlashed } from "./_flash";
import { clickNav, clickProfileSub } from "./_nav";
import { stubVaultSave } from "./_stubs";

// W5 data-entry editor, folded in W35 into the Personalization component; W37 moved it to the
// Patient tab as its first subsection (Profile). M57 — every field persists immediately (no Save
// button exists anymore), so the second test below now edits-and-reverts Notes for real rather
// than exercising a no-op UI state.

async function openPersonalization(page: Page, patient: string) {
  await openAsProvider(page, patient);
  await clickNav(page, "Profile");
  await page.waitForSelector(".personalization", { timeout: 10_000 });
}

// M65 — Allergies and Family are new Patient subsections, right of Profile.
// W48 — nested under Profile now (Bio/Allergies/Family), reachable only via clickProfileSub.
async function openAllergies(page: Page, patient: string) {
  await openAsProvider(page, patient);
  await clickProfileSub(page, "Allergies");
  await page.waitForSelector(".allergies", { timeout: 10_000 });
}

async function openFamily(page: Page, patient: string) {
  await openAsProvider(page, patient);
  await clickProfileSub(page, "Family");
  await page.waitForSelector(".family", { timeout: 10_000 });
}

test("Personalization is a single basic-details block (no sub-tabs, no Close/Discard)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await openPersonalization(page, "Alex");

  // A single block (W20 moved Diagnosed Diseases → Clinical Reports; W30 retired the Watchlist
  // block; W33 moved Treatments CRUD to Profile → Treatment; M65 retired Correlations, folding
  // legacy data into noteEntries; M94/M-translate: Conditions/Symptoms was later fully removed,
  // leaving just the basic-details form here).
  await expect(page.locator(".personalization .pz-block")).toHaveCount(1);

  // No sub-tab bar and no Close/Discard, and (M57) no outer Save button at all — every field
  // persists on its own (blur/change).
  // By the buttons' NAMES, not by `.tabs`/`.btn.ghost` — neither class has existed since the
  // sub-tab bar and the Close/Discard pair were retired, so both assertions passed no matter what
  // the editor rendered. A reintroduced Save button need not bring the old class back with it; it
  // would have to say "Save". `.pz-editbar` is live markup (Personalization.svelte:53), so that
  // line still means something and stays.
  await expect(page.locator(".personalization").getByRole("button", { name: /^(Save|Close|Discard|Cancel)$/ })).toHaveCount(0);
  await expect(page.locator(".pz-editbar .btn.primary")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("editing Goal persists immediately on blur, no Save button needed (M57)", async ({ page }) => {
  await openPersonalization(page, "Alex");

  // M64 retired the separate Notes scalar field this test used to target; Goal exercises the
  // identical blur-persist behavior and still exists.
  const goal = page
    .locator(".personalization label.field", { has: page.getByText("Goal", { exact: true }) })
    .locator("textarea");
  const original = await goal.inputValue();
  // Capitalized — normalizeClientDraft applies capFirst to goal on every persist (factors-edit.ts),
  // so a lowercase-starting sentinel would round-trip mutated and fail a naive equality check.
  const marker = `Edited in test — M57 ${Date.now()}`;
  await goal.fill(marker);
  await goal.blur();
  await expect(page.locator(".personalization .saved")).toBeVisible({ timeout: 10_000 });

  // Reload with no Save click ever — the blur's own immediate persist is what's under test.
  await page.reload();
  await page.waitForSelector(".roster-list");
  await page.click('.roster-name:has-text("Alex")');
  await clickNav(page, "Profile");
  const reloadedGoal = page
    .locator(".personalization label.field", { has: page.getByText("Goal", { exact: true }) })
    .locator("textarea");
  await expect(reloadedGoal).toHaveValue(marker);

  // Restore the original value so this test doesn't leave garbage in Alex's real profile.
  await reloadedGoal.fill(original);
  await reloadedGoal.blur();
  await expect(page.locator(".personalization .saved")).toBeVisible({ timeout: 10_000 });
});

test("Allergies: modal-Add, modal-Edit, and Delete all persist immediately (M66)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M65 allergen ${Date.now()}`;
  const edited = `M65 allergen edited ${Date.now()}`;

  await openAllergies(page, "Alex");

  await page.locator('.side-row-action[aria-label="Add allergy"]').click();
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Add allergy");
  await page.locator(".az-modal input[type=text]").first().fill(marker);
  await watchFlashes(page);
  await page.locator(".az-modal .btn.primary", { hasText: "Save" }).click();

  // M66 P4 — Save fires onSaved(conditionAnchor(allergen)); the page scrolls to and flashes the
  // saved row (no filter exists on this component, so there's no filter-hides-target case here).
  const row = page.locator(".allergies .leaf-card", { hasText: marker });
  const anchorId = await row.locator(".permalink-heading").first().getAttribute("id");
  await expectFlashed(page, anchorId);
  await expect(page.locator(".allergies .saved")).toBeVisible({ timeout: 10_000 });

  await clickLeafMenuItem(row, "Edit");
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Edit allergy");
  await expect(page.locator(".az-modal input[type=text]").first()).toHaveValue(marker);
  await page.locator(".az-modal input[type=text]").first().fill(edited);
  await watchFlashes(page);
  await page.locator(".az-modal .btn.primary", { hasText: "Save" }).click();

  const editedRow = page.locator(".allergies .leaf-card", { hasText: edited });
  const editedAnchorId = await editedRow.locator(".permalink-heading").first().getAttribute("id");
  await expectFlashed(page, editedAnchorId);
  await expect(page.locator(".allergies .saved")).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await page.waitForSelector(".roster-list");
  await page.click('.roster-name:has-text("Alex")');
  await clickProfileSub(page, "Allergies");
  await expect(page.locator(".allergies")).toContainText(edited);
  await expect(page.locator(".allergies")).not.toContainText(marker);

  const reloadedRow = page.locator(".allergies .leaf-card", { hasText: edited });
  await clickLeafMenuItem(reloadedRow, "Delete");
  await expect(page.locator(".allergies")).not.toContainText(edited);
});

test("Family: modal-Add, modal-Edit, and Delete all persist immediately (M66)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M65 family ${Date.now()}`;
  const edited = `M65 family edited ${Date.now()}`;

  await openFamily(page, "Alex");

  await page.locator('.side-row-action[aria-label="Add family history"]').click();
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Add family history");
  await page.locator(".fh-modal input[type=text]").first().fill(marker);
  await page.locator(".fh-modal input[type=text]").nth(1).fill("Note");
  await watchFlashes(page);
  await page.locator(".fh-modal .btn.primary", { hasText: "Save" }).click();

  // M66 P4 — Save fires onSaved(conditionAnchor(relation)); the page scrolls to and flashes the
  // saved row (no filter exists on this component, so there's no filter-hides-target case here).
  const row = page.locator(".family .leaf-card", { hasText: marker });
  const anchorId = await row.locator(".permalink-heading").first().getAttribute("id");
  await expectFlashed(page, anchorId);
  await expect(page.locator(".family .saved")).toBeVisible({ timeout: 10_000 });

  await clickLeafMenuItem(row, "Edit");
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Edit family history");
  await expect(page.locator(".fh-modal input[type=text]").first()).toHaveValue(marker);
  await page.locator(".fh-modal input[type=text]").first().fill(edited);
  await watchFlashes(page);
  await page.locator(".fh-modal .btn.primary", { hasText: "Save" }).click();

  const editedRow = page.locator(".family .leaf-card", { hasText: edited });
  const editedAnchorId = await editedRow.locator(".permalink-heading").first().getAttribute("id");
  await expectFlashed(page, editedAnchorId);
  await expect(page.locator(".family .saved")).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await page.waitForSelector(".roster-list");
  await page.click('.roster-name:has-text("Alex")');
  await clickProfileSub(page, "Family");
  await expect(page.locator(".family")).toContainText(edited);
  await expect(page.locator(".family")).not.toContainText(marker);

  const reloadedRow = page.locator(".family .leaf-card", { hasText: edited });
  await clickLeafMenuItem(reloadedRow, "Delete");
  await expect(page.locator(".family")).not.toContainText(edited);
});

test("Allergies and Family: the sidebar '+' row action opens the Add modal (M77 P5)", async ({ page }) => {
  await openAllergies(page, "Alex");
  await page.locator('.side-row-action[aria-label="Add allergy"]').click();
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Add allergy");
  await page.locator(".az-modal .btn", { hasText: "Cancel" }).click();

  // Same session — switch sub-tab directly rather than re-running openFamily's own login (already
  // authenticated, so a second loginAs would never see the email/password form again).
  await clickProfileSub(page, "Family");
  await page.waitForSelector(".family", { timeout: 10_000 });
  await page.locator('.side-row-action[aria-label="Add family history"]').click();
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Add family history");
});

// W63 — Family edited and deleted by the row's index in the SORTED view, applied to the UNSORTED
// draft array. With anything pinned the two disagree, so Delete removed a different entry than the
// one clicked and Edit overwrote a different one — silent loss of patient-entered data. The tests
// above never pinned anything, which is exactly why it survived.
//
// Vault writes are stubbed: this exercises the in-memory dispatch, and the shared Alex fixture
// must not carry three throwaway relations into every later spec.
test("Family: Delete and Edit act on the row you clicked, not the one at that index", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await stubVaultSave(page);
  const alpha = `W63 alpha ${Date.now()}`;
  const beta = `W63 beta ${Date.now()}`;

  await openFamily(page, "Alex");
  for (const relation of [alpha, beta]) {
    await page.locator('.side-row-action[aria-label="Add family history"]').click();
    await page.locator(".fh-modal input[type=text]").first().fill(relation);
    await page.locator(".fh-modal input[type=text]").nth(1).fill("Note");
  await page.locator(".fh-modal .btn.primary", { hasText: "Save" }).click();
    await expect(page.locator(".family .leaf-card", { hasText: relation })).toBeVisible();
  }

  // Pin the LAST row so the sorted view and the underlying array stop agreeing.
  const betaRow = page.locator(".family .leaf-card", { hasText: beta });
  await clickLeafMenuItem(betaRow, "Pin");
  await expect(page.locator(".family .leaf-card").first()).toContainText(beta);

  // Delete the pinned row, which now sits at sorted index 0 — the old code spliced index 0 of the
  // unsorted array instead, taking the fixture's own "Mother" entry with it.
  await clickLeafMenuItem(page.locator(".family .leaf-card").first(), "Delete");
  await expect(page.locator(".family")).not.toContainText(beta);
  await expect(page.locator(".family")).toContainText(alpha);
  await expect(page.locator(".family")).toContainText("Mother");

  // Same for Edit: pin alpha to the top, edit it, and check the new text landed on alpha.
  const alphaRow = page.locator(".family .leaf-card", { hasText: alpha });
  await clickLeafMenuItem(alphaRow, "Pin");
  await expect(page.locator(".family .leaf-card").first()).toContainText(alpha);

  const edited = `${alpha} edited`;
  await clickLeafMenuItem(page.locator(".family .leaf-card").first(), "Edit");
  await expect(page.locator(".fh-modal input[type=text]").first()).toHaveValue(alpha);
  await page.locator(".fh-modal input[type=text]").first().fill(edited);
  await page.locator(".fh-modal .btn.primary", { hasText: "Save" }).click();

  await expect(page.locator(".family")).toContainText(edited);
  await expect(page.locator(".family")).toContainText("Mother");
  await expect(page.locator(".family .leaf-card", { hasText: "Mother" })).not.toContainText(edited);
});

// W63 — the heading permalink had the same index/array mismatch: rowAnchor() was handed the
// unsorted array with an index from the sorted loop. The symptom is not that a row shows the wrong
// TEXT — the id is stamped on the row's own heading either way — it is that the id belongs to a
// DIFFERENT row, so two rows claim one anchor and a permalink resolves to whichever comes first.
// Assert the ids are distinct; asserting the heading's text passes on the broken code too.
test("Family: each row's permalink id stays its own once something is pinned", async ({ page }) => {
  await stubVaultSave(page);
  const relation = `W63 anchor ${Date.now()}`;
  await openFamily(page, "Alex");

  await page.locator('.side-row-action[aria-label="Add family history"]').click();
  await page.locator(".fh-modal input[type=text]").first().fill(relation);
  await page.locator(".fh-modal input[type=text]").nth(1).fill("Note");
  await page.locator(".fh-modal .btn.primary", { hasText: "Save" }).click();

  const row = page.locator(".family .leaf-card", { hasText: relation });
  await clickLeafMenuItem(row, "Pin");
  await expect(page.locator(".family .leaf-card").first()).toContainText(relation);

  const ids = await page.locator(".family .leaf-card .permalink-heading").evaluateAll((els) =>
    els.map((e) => e.id),
  );
  expect(ids.length).toBeGreaterThan(1);
  expect(new Set(ids).size, `duplicate permalink ids: ${ids.join(", ")}`).toBe(ids.length);
  // And the pinned row's id is derived from its OWN relation, not the row that array position holds.
  expect(ids[0]).toContain("w63-anchor");
});

// W64 — Allergies had no pin coverage at all: its pin is the one affordance the M66 test above
// never touches. Written while converting the pin from index- to id-based dispatch.
//
// HONEST NOTE ON WHAT THIS PROVES: it passes against BOTH implementations. It was written expecting
// the index version to fail, and it does not — saveEdits applies optimistically before its PUT, so
// the last-saved `client` already holds a just-added entry and the draft/payload arrays never
// diverge here. The id-based version is kept for robustness and for consistency with Family, not
// because this test caught something. What this DOES cover, which nothing did before: that pinning
// an allergy survives a reload and lands on the row that was clicked.
test("Allergies: a pin survives a reload on the row that was clicked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const first = `W64 alpha ${Date.now()}`;
  const second = `W64 beta ${Date.now()}`;

  await openAllergies(page, "Alex");
  for (const allergen of [first, second]) {
    await page.locator('.side-row-action[aria-label="Add allergy"]').click();
    await page.locator(".az-modal input[type=text]").first().fill(allergen);
  await page.locator(".az-modal .btn.primary", { hasText: "Save" }).click();
    await expect(page.locator(".allergies .saved")).toBeVisible({ timeout: 10_000 });
  }

  // Pin the SECOND one, immediately after adding — the window where the draft array and the
  // last-saved payload can disagree.
  await clickLeafMenuItem(page.locator(".allergies .leaf-card", { hasText: second }), "Pin");

  await page.reload();
  await page.waitForSelector(".roster-list");
  await page.click('.roster-name:has-text("Alex")');
  await clickProfileSub(page, "Allergies");

  const pinnedRow = page.locator(".allergies .leaf-card", { hasText: second });
  await expect(pinnedRow.locator(".pin-star").first()).toHaveClass(/visible/);
  await expect(page.locator(".allergies .leaf-card", { hasText: first }).locator(".pin-star").first())
    .not.toHaveClass(/visible/);
  expect(errors, "persistNow must not throw on a just-added entry").toEqual([]);

  // Leave the shared Alex fixture as we found it.
  for (const allergen of [first, second]) {
    await clickLeafMenuItem(page.locator(".allergies .leaf-card", { hasText: allergen }), "Delete");
    await expect(page.locator(".allergies")).not.toContainText(allergen);
  }
});

// W64 / #99 — CLOSED WITHOUT A TEST, deliberately. The invariant the deleted M56 test named ("an
// in-progress edit survives an unrelated delete") is no longer at risk: M66 moved every editor to a
// modal bound to a CLONE of the row (`newEntry = { ...f }`), so a draft resync rebuilds `draft`
// without touching what is being typed.
//
// The collision that would still be decidable — the edited row deleted from the sidebar mid-edit —
// cannot be performed: Modal.svelte's backdrop covers the sidebar (elementFromPoint returns
// DIV.modal-backdrop) and its onclick closes the modal, so the delete never happens with the modal
// open. A test would have to force clicks past the backdrop, i.e. assert a flow no user can reach.
// Family.svelte's saveNewEntry records which way that collision resolves if it ever becomes
// reachable (a live cross-session sync would do it).
