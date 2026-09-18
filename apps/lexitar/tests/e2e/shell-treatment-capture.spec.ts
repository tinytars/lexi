import { test, expect } from "./_fixtures";
import { openSyntheticAsProvider } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { gotoTreatmentBucket, identifyTreatmentByText } from "./_shell";

// The two Treatment extractors — From text and From photos — and what the dose conclusion is
// allowed to claim from what they produce.
//
// W76 — split out of shell-treatment.spec.ts, which paired with shell-study-hypothesis into the
// heaviest 24-way slice in the suite (16 tests) and lost workerd there twice. See gate.yml's e2e
// job for why the answer to a fat slice is always to split the file, never to re-cut the shard.

// "From text": the input people actually have for a formulated supplement. The reference case is a
// 13-ingredient product sheet whose "Protocol: one capsule daily" must NOT become the patient's dose —
// ingredient amounts are label facts, and conflating the two misreports what the patient takes.
const SHEET_RESULT = {
  kind: "supplement",
  description: "MD-formulated supplement supporting thyroid hormone production and conversion.",
  ingredients: [
    { name: "Selenium", amount: 100, unit: "mcg", form: "L-Selenomethionine" },
    { name: "Iodine", amount: 225, unit: "mcg", form: "Potassium Iodide" },
    { name: "Zinc", amount: 15, unit: "mg", form: "Zinc Bisglycinate" },
    { name: "Taurine", amount: 150, unit: "mg" },
  ],
  links: [{ label: "Third-party testing", url: "https://www.marekhealth.com/coa/thyroid-support_26021005.html" }],
};

test("Treatment: From text extracts a product sheet into description/ingredients/links, without touching the dose", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `Thyroid Support ${Date.now()}`;
  const posted: { text?: string; images?: unknown }[] = [];
  await page.route("**/api/treatment-infer", async (route) => {
    posted.push(route.request().postDataJSON());
    // The name comes back from the extraction, not from typing: an inferred name renders readonly,
    // exactly as the photo flow already locks it.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...SHEET_RESULT, name: marker }) });
  });
  await page.getByTitle("Add treatment").click();
  await page.locator(".add-mode-toggle .btn", { hasText: "From text" }).click();
  await page.locator(".text-intake textarea").fill("Thyroid Support\nIngredients: 100mcg Selenium…\nProtocol: one capsule daily");
  await page.locator(".text-intake .btn", { hasText: "Extract from text" }).click();
  await expect(page.locator(".ai-tag")).toBeVisible({ timeout: 10_000 });

  // Text went up, no images — one endpoint, but only the input the user actually gave.
  expect(posted).toHaveLength(1);
  expect(posted[0].text).toContain("Selenium");
  expect(posted[0].images).toBeUndefined();

  // The dose stays the patient's to enter: no ingredient amount may have prefilled it.
  await expect(page.locator(".tedit .field", { hasText: "Amount" }).locator("input")).toHaveValue("");

  await expect(page.locator(".tedit .field", { hasText: "Name" }).locator("input")).toHaveValue(marker);
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-01-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "All");
  const card = page.locator(".med-group", { hasText: marker });

  // The extraction renders in its own LexiTar-labeled turn, separate from the dose history — and
  // the raw pasted text stays one click away, so what LexiTar inferred is never confused with
  // what the source actually said.
  const extracted = card.locator(".persona-bubble.p-assistant", { hasText: "Extracted" });
  await expect(extracted).toContainText("MD-formulated supplement");
  await expect(extracted).toContainText("L-Selenomethionine");
  const link = extracted.locator(".med-links a");
  await expect(link).toHaveAttribute("href", SHEET_RESULT.links[0].url);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await extracted.locator(".med-raw-text summary").click();
  await expect(extracted.locator(".med-raw-text p")).toContainText("Selenium");

  // Edit is where the product lives — and the whole ingredient list is there, uncapped.
  // M-locked-fields — description/ingredients are LexiTar's own reading of the label, so they render
  // as plain read-only text here now, not an editable textarea/list.
  await clickLeafMenuItem(card, "Edit");
  await expect(page.locator(".tedit .field", { hasText: "Product description" })).toContainText(/MD-formulated/);
  await expect(page.locator(".tedit .ing-list li").first()).toHaveText("100mcg Selenium (L-Selenomethionine)");
  await expect(page.locator(".tedit .ing-list li")).toHaveCount(SHEET_RESULT.ingredients.length);
  await page.locator(".tedit-actions .btn", { hasText: "Cancel" }).click();

  await clickLeafMenuItem(card, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// A valid, minimal 1x1 PNG — createImageBitmap (image-compress.ts) needs a real decodable image,
// not an arbitrary buffer.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// "From photos" must leave the raw capture on file, not just its extraction: the photo the user
// picked to identify from has to survive as an Attachment, linked via rawCaptureAttachmentKeys,
// so a later PHI review can always find the original next to what LexiTar read off it.
test("Treatment: From photos persists the raw capture alongside the extraction", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `Bottle Product ${Date.now()}`;
  await page.route("**/api/treatment-infer", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: marker, kind: "drug", description: "Extracted from a label photo." }),
    });
  });
  await page.route("**/api/raw/**", (route) => route.fulfill({ status: 204, body: "" }));

  await page.getByTitle("Add treatment").click();
  await page.locator(".add-mode-toggle .btn", { hasText: "From photos" }).click();
  await page.setInputFiles(".photo-intake input[type=file]", { name: "bottle.png", mimeType: "image/png", buffer: TINY_PNG });
  await expect(page.locator(".photo-preview")).toBeVisible();
  await page.locator(".photo-intake .btn", { hasText: "Identify from photos" }).click();
  await expect(page.locator(".ai-tag")).toBeVisible({ timeout: 10_000 });

  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-01-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "All");
  const card = page.locator(".med-group", { hasText: marker });
  const extracted = card.locator(".persona-bubble.p-assistant", { hasText: "Extracted" });
  await expect(extracted).toContainText("Extracted from a label photo.");
  // The exact photo that produced the extraction is right there, not just referenced by claim.
  await expect(extracted.locator(".med-raw-capture .attachment-chip")).toHaveCount(1);

  await clickLeafMenuItem(card, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// No "Manual" option: a brand-new treatment's ONLY entry point is a capture. Nothing else in the
// modal — not the fields, not a way to Save — is reachable until an extraction succeeds.
test("Treatment: a fresh Add shows nothing but capture until an extraction succeeds", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  await page.getByTitle("Add treatment").click();
  await expect(page.locator(".add-mode-toggle .btn", { hasText: "Manual" })).toHaveCount(0);
  await expect(page.locator(".tedit .field", { hasText: "Name" })).toHaveCount(0);
  await expect(page.locator(".tedit .field", { hasText: "Amount" })).toHaveCount(0);
  await expect(page.locator(".tedit-actions .btn.primary", { hasText: "Save" })).toBeDisabled();
  await expect(page.locator(".tedit .ct-empty", { hasText: "Add a photo or paste text" })).toBeVisible();

  const marker = `M-capture-gate ${Date.now()}`;
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await expect(page.locator(".tedit .field", { hasText: "Name" }).locator("input")).toHaveValue(marker);
  await expect(page.locator(".tedit-actions .btn.primary", { hasText: "Save" })).toBeEnabled();

  await page.locator(".tedit-actions .btn", { hasText: "Cancel" }).click();
});

// Turn 2's administration locks turn 3's unit (the patient supplies a count, never a different
// unit), and turn 4 computes the real clinical total from turn 2's ingredients × turn 3's count —
// "2 softgel/day" means nothing to an ER doctor; "1000mg/day EPA" does.
test("Treatment: administration locks Unit and computes a Daily total from the patient's own quantity", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-conclusion ${Date.now()}`;
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, {
    name: marker,
    kind: "supplement",
    ingredients: [{ name: "EPA", amount: 500, unit: "mg" }],
    administration: { unit: "softgel", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" },
  });

  const unit = page.locator(".tedit .field", { hasText: "Unit" }).locator("input");
  await expect(unit).toHaveValue("softgel");
  await expect(unit).not.toBeEditable();
  // Anchored: a plain-string hasText is a case-insensitive substring match, and the Ingredients
  // field's "label amounts, per serving" note also contains "amount" — /^Amount/ picks only the
  // field whose own text actually STARTS with "Amount".
  await expect(page.locator(".tedit .field", { hasText: /^Amount/ })).toContainText("standard is 1 softgel/day");

  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("2");
  // Frequency is the patient's own, independent of the label's suggestion — it starts unset
  // ("—"), and an unset frequency correctly refuses a total rather than guessing one.
  await page.locator(".tedit .field", { hasText: "Frequency" }).locator("select").selectOption("day");
  // Live preview, before Save: 2 softgels/day of a 500mg-EPA-per-softgel product is 1000mg/day.
  await expect(page.locator(".tedit .conclusion-preview")).toContainText("1000mg/day EPA");

  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-01-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "All");
  const card = page.locator(".med-group", { hasText: marker });
  const total = card.locator(".persona-bubble.p-assistant", { hasText: "Daily total" });
  await expect(total).toContainText("1000mg/day EPA");

  await clickLeafMenuItem(card, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// "as needed" dosing has no fixed daily rate — the conclusion must say so plainly, never guess a
// number, and never render nothing (silence reads as "not applicable", not "refused to compute").
test("Treatment: 'as needed' dosing shows an explanatory line, not a fabricated total", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-as-needed ${Date.now()}`;
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, {
    name: marker,
    kind: "drug",
    ingredients: [{ name: "Ibuprofen", amount: 200, unit: "mg" }],
    administration: { unit: "tablet", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "as needed" },
  });
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("1");
  await page.locator(".tedit .field", { hasText: "Frequency" }).locator("select").selectOption("as needed");
  await expect(page.locator(".tedit .conclusion-preview")).toContainText("Dosed as needed — no daily total.");

  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-01-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "All");
  const card = page.locator(".med-group", { hasText: marker });
  await expect(card).toContainText("Dosed as needed — no daily total.");
  await expect(card.locator(".persona-bubble.p-assistant", { hasText: "Daily total" })).toHaveCount(0);

  await clickLeafMenuItem(card, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// Turn 2's administration is medicine-level; re-extracting an EXISTING drug must relabel every
// sibling dose row's Unit to match, or a Daily total can never compute for a drug that predates
// the turn-2/3/4 redesign — its rows keep whatever free-text unit word they were first entered
// with, forever disagreeing with the newly-locked one. doseAmount is left untouched: its existing
// numeric value is taken as already being a count of the new unit (M-doseunit-relabel).
test("Treatment: re-extracting an existing drug relabels every sibling row's Unit, unlocking the Daily total", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M-relabel ${Date.now()}`;

  // Row 1 — legacy hand-entered dose, unit "capsule".
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("1");
  await page.locator(".tedit .field", { hasText: "Unit" }).locator("input").fill("capsule");
  await page.locator(".tedit .field", { hasText: "Frequency" }).locator("select").selectOption("day");
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-01-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // Row 2 — same drug, a DIFFERENT legacy unit ("tablet"): two hand-entered dose periods that never
  // agreed on a unit word in the first place, exactly the case a blind single-unit fix would miss.
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("2");
  await page.locator(".tedit .field", { hasText: "Unit" }).locator("input").fill("tablet");
  await page.locator(".tedit .field", { hasText: "Frequency" }).locator("select").selectOption("day");
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-02-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "All");
  const card = page.locator(".med-group", { hasText: marker });
  await expect(card.locator(".persona-bubble.p-assistant", { hasText: "Daily total" })).toHaveCount(0);

  // Medicine-scope re-extraction: attaches administration + ingredients for the first time.
  await clickLeafMenuItem(card, "Edit");
  await identifyTreatmentByText(page, {
    name: marker,
    kind: "drug",
    ingredients: [{ name: "EPA", amount: 500, unit: "mg" }],
    administration: { unit: "softgel", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" },
  });
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // Both rows now carry the new unit — neither hand-edited — and the combined total reflects BOTH
  // rows' own doseAmount (1 + 2 = 3 softgels/day of 500mg EPA each = 1500mg/day).
  await expect(card).toContainText("1softgel/day");
  await expect(card).toContainText("2softgel/day");
  const total = card.locator(".persona-bubble.p-assistant", { hasText: "Daily total" });
  await expect(total).toContainText("1500mg/day EPA");

  await clickLeafMenuItem(card, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});
