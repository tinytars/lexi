import { test, expect } from "./_fixtures";
import { openSyntheticAsProvider, openFreshSyntheticAsProvider, reloadOntoPatient } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { watchFlashes, expectFlashed } from "./_flash";
import { gotoTreatmentBucket, editFirstDoseEntry } from "./_shell";
import { validLeafPayload } from "./_leaf-payloads";

// Study and Hypothesis: the two provider-only sections, and their in-place CRUD.
//
// M57/M66/M67 removed the outer Save button from both — every Add, Edit and Delete persists on its
// own, which is what most of these assert. The stale-draft clobber test (M55/M56) belongs here
// rather than with the leaf-regen triggers: what it protects is the DELETE, against a background
// regen landing mid-edit.

test("Investigator → Hypothesis shows weighed hypotheses (no committed Plan) with the AI's take (W20/W21/W23/W25)", async ({ page }) => {
  const who = await openSyntheticAsProvider(page);
  await clickNav(page, "Hypothesis");
  await expect(page.locator(".future-treatment .leaf-card").first()).toBeVisible();
  // Cardiovascular Risk (the default system) is where the fixture's lipid-lowering AI idea lives
  // (treatmentGroups' "Lipid lowering" topic, ai: [Bempedoic acid, Rosuvastatin]).
  await expect(page.locator(".future-treatment")).toContainText(`Rosuvastatin ${who.tag}`);
  // W23: the committed Plan moved to Treatment Plan — its "Continue …" / "Start … (TBD)" actions
  // no longer appear here (they'd otherwise duplicate the weighed hypotheses).
  await expect(page.locator(".future-treatment")).not.toContainText("(TBD)");
  // M76/Phase 4 — Hypothesis renders one body system at a time now; the fixture's patient hypothesis
  // (Berberine, decisions.patient) paired with the AI's take lives under Metabolic Health, not the
  // default Cardiovascular Risk system, so select it before asserting.
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Metabolic Health" }).click();
  await expect(page.locator(".future-treatment .persona-bubble.p-owner").first()).toBeVisible();
  await expect(page.locator(".future-treatment .persona-bubble.p-assistant").first()).toBeVisible();
  // The AI's take on a patient hypothesis (pros/cons/alternatives/recommendation) is available inline.
  // M91 — the per-topic block was extracted into HypothesisTopicCard.svelte (`.htc-*` classes).
  await expect(page.locator(".future-treatment .htc-eval").first()).toBeVisible();
});

test("Investigator → Study is its own subsection with in-place CRUD, pairing pursued study with the AI result (W20/W34)", async ({ page }) => {
  await openSyntheticAsProvider(page);
  // Study is its own sub-tab now (moved out of Analysis).
  await clickNav(page, "Analysis");
  await expect(page.locator(".analysis")).not.toContainText("Study Result");
  await clickNav(page, "Study");
  // The provider sees a read view (not a wall of inputs) with a Save bar and the AI result on the right.
  await expect(page.locator(".study .study-editbar")).toBeVisible();
  await expect(page.locator(".study .leaf-card").first()).toBeVisible();
  await expect(page.locator(".study .persona-bubble.p-assistant").first()).toBeVisible();
  // M67 — clicking the ✎ on a row reopens the shared Add/Edit modal, pre-filled (mirrors Treatment).
  await expect(page.locator(".study .sr-input")).toHaveCount(0);
  await clickLeafMenuItem(page.locator(".study .leaf-card").first(), "Edit");
  await expect(page.locator(".study-modal .sr-input")).toBeVisible();
});

test("a Study delete survives a background /api/leaf-regen (treatmentGroups) landing mid-edit — stale-draft clobber fix (M55/M56)", async ({ page }) => {
  page.on("dialog", (d) => d.accept()); // Study's delete confirm()
  const marker = `M55 race-test ${Date.now()}`;

  // Held until the delete has persisted, so the regen's merge deterministically lands after it.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let groupsRegen = 0;
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string; inputs?: Record<string, unknown> };
    if (body.node !== "treatmentGroups") return route.fallback();
    groupsRegen++;
    const result = validLeafPayload("treatmentGroups", body.inputs ?? {}, { text: "M55 stub group" });
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) });
  });

  // The fresh patient opens every node stale, so the dose edit below can arm the regen.
  const who = await openFreshSyntheticAsProvider(page);

  // Persist a genuine Study row first (so its later removal is an actual diff from baseline). M57 —
  // Add is a modal now; its own Save persists immediately (no outer Save button exists for Study).
  await clickNav(page, "Study");
  await page.getByTitle("Add study").click();
  await page.locator(".study-modal .topic-input").fill(marker);
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });

  // A dose-only edit leaves treatmentGroups the sole stale node, firing the held regen above.
  await clickNav(page, "Treatment");
  await gotoTreatmentBucket(page, "Ongoing");
  await editFirstDoseEntry(page);
  await page.locator(".tedit .field", { hasText: "Amount" }).locator("input").fill(String(Date.now()));
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => groupsRegen, { message: "no treatmentGroups regen fired — the clobber window was never armed" }).toBeGreaterThan(0);

  const vaultPut = () => page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/api/vault/"));
  await clickNav(page, "Study");
  const row = page.locator(".study .leaf-card", { hasText: marker });
  const deleted = vaultPut();
  await clickLeafMenuItem(row, "Delete");
  await expect(page.locator(".study")).not.toContainText(marker);
  await deleted;

  const merged = vaultPut();
  release();
  await merged;
  await expect(page.locator(".study")).not.toContainText(marker);

  // Reload with NO Save click at all — the delete's own immediate persist is what's under test.
  await reloadOntoPatient(page, who);
  await clickNav(page, "Study");
  await expect(page.locator(".study")).not.toContainText(marker);
});

test("Study has no outer Save button — Add (modal) and Delete both persist immediately (M57)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M57 immediate-persist ${Date.now()}`;

  const who = await openSyntheticAsProvider(page);
  await clickNav(page, "Study");
  await expect(page.locator(".study-editbar .btn.primary")).toHaveCount(0);

  await page.getByTitle("Add study").click();
  await page.locator(".study-modal .topic-input").fill(marker);
  await watchFlashes(page);
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();

  const row = page.locator(".study .leaf-card", { hasText: marker });
  const anchorId = await row.locator(".permalink-heading").first().getAttribute("id");
  await expectFlashed(page, anchorId);
  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });

  await clickLeafMenuItem(row, "Delete");
  await expect(page.locator(".study")).not.toContainText(marker);
  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });

  await reloadOntoPatient(page, who);
  await clickNav(page, "Study");
  await expect(page.locator(".study")).not.toContainText(marker);
});

test("editing a Study row persists immediately via the Edit modal, no outer Save needed (M57/M67)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M57 edit-done ${Date.now()}`;
  const edited = `M57 edited ${Date.now()}`;

  const who = await openSyntheticAsProvider(page);
  await clickNav(page, "Study");

  await page.getByTitle("Add study").click();
  await page.locator(".study-modal .topic-input").fill(marker);
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });

  // M67 — Edit reopens the same Add modal, pre-filled; its own Save persists immediately.
  const row = page.locator(".study .leaf-card", { hasText: marker });
  await clickLeafMenuItem(row, "Edit");
  await page.locator(".study-modal .topic-input").fill(edited);
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });

  // Reload with no outer Save click ever — the modal's own Save is what's under test.
  await reloadOntoPatient(page, who);
  await clickNav(page, "Study");
  await expect(page.locator(".study")).toContainText(edited);
  await expect(page.locator(".study")).not.toContainText(marker);
});

test("Hypothesis has no outer Save button — Add (modal), modal-Edit, and Delete all persist immediately (M66)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M57 idea ${Date.now()}`;
  const edited = `M57 idea edited ${Date.now()}`;

  const who = await openSyntheticAsProvider(page);
  await clickNav(page, "Hypothesis");
  await expect(page.locator(".ft-editbar .btn.primary")).toHaveCount(0);

  await page.getByTitle("Add idea").click();
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Add idea");
  await page.locator(".ft-modal .topic-input").fill(marker);
  await watchFlashes(page);
  await page.locator(".ft-modal .btn.primary", { hasText: "Save" }).click();

  const addedRow = page.locator(".future-treatment .leaf-card", { hasText: marker });
  const addedAnchorId = await addedRow.locator(".permalink-heading").first().getAttribute("id");
  await expectFlashed(page, addedAnchorId);
  await expect(page.locator(".future-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // M66 — ✎ opens the same Add modal, pre-filled, instead of an in-place Done-to-save row.
  const row = page.locator(".future-treatment .leaf-card", { hasText: marker });
  await clickLeafMenuItem(row, "Edit");
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Edit idea");
  await expect(page.locator(".ft-modal .topic-input")).toHaveValue(marker);
  await page.locator(".ft-modal .topic-input").fill(edited);
  await watchFlashes(page);
  await page.locator(".ft-modal .btn.primary", { hasText: "Save" }).click();

  const editedRowLive = page.locator(".future-treatment .leaf-card", { hasText: edited });
  const editedAnchorId = await editedRowLive.locator(".permalink-heading").first().getAttribute("id");
  await expectFlashed(page, editedAnchorId);
  await expect(page.locator(".future-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await reloadOntoPatient(page, who);
  await clickNav(page, "Hypothesis");
  await expect(page.locator(".future-treatment")).toContainText(edited);
  await expect(page.locator(".future-treatment")).not.toContainText(marker);

  // Delete persists immediately too — it's a direct row action now, no Edit-open step first.
  const editedRow = page.locator(".future-treatment .leaf-card", { hasText: edited });
  await clickLeafMenuItem(editedRow, "Delete");
  await expect(page.locator(".future-treatment")).not.toContainText(edited);

  await reloadOntoPatient(page, who);
  await clickNav(page, "Hypothesis");
  await expect(page.locator(".future-treatment")).not.toContainText(edited);
});
