import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSyntheticAsProvider, openFreshSynthetic, openFreshSyntheticAsProvider } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { gotoTreatmentBucket, identifyTreatmentByText, addOngoingTreatment, editFirstDoseEntry } from "./_shell";
import { treatmentLabel } from "@pablotech/akesi/treatment-bucket";

// The /api/leaf-regen relay from the UI side; queue counts and dedupe are unit-tested in leaf-regen-queue.test.ts.
// Fresh patients open with every node stale, so the relay actually fires.

type LeafBody = {
  node?: string;
  targetLabels?: string[];
  inputs?: {
    treatmentHistory?: { id: string; name: string; doseAmount?: number; reason?: string }[];
    patientHypothesis?: { intervention: string; purpose?: string }[];
    aiFindings?: { group: string }[];
    pursuedStudy?: { entries?: { focus: string }[] };
  };
};

const scopedLabels = (posted: LeafBody[], node: string) =>
  posted.filter((b) => b.node === node && b.targetLabels?.length).map((b) => b.targetLabels);

const historyOf = (b: LeafBody, name: string) => (b.inputs?.treatmentHistory ?? []).filter((h) => h.name === name);

// The dose row belonging to one named medicine, rather than whichever row happens to be first.
function doseRowOf(page: Page, name: string) {
  return page.locator(".med-group", { hasText: name }).locator(".med-table td.med-actions .btn", { hasText: "Edit" }).first();
}

test("a dose-only Treatment edit still fires treatmentGroups through the generic /api/leaf-regen relay (M66 P8 regression)", async ({ page }) => {
  const posted: { node?: string }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string };
    posted.push(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { groups: [] } }) });
  });

  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Treatment");
  await gotoTreatmentBucket(page, "Ongoing");
  await editFirstDoseEntry(page);
  await page.locator(".tedit .field", { hasText: "Amount" }).locator("input").fill(String(Date.now()));
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => posted.some((b) => b.node === "treatmentGroups"), { timeout: 10_000 }).toBe(true);
});

test("Treatment (Planned bucket): Add fires the aiOnPlan trigger; the mocked plan assessment merges into the read view (M66 P8)", async ({ page }) => {
  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const marker = `M66 plan rx ${Date.now()}`;
  const doseAmount = "10";
  const doseUnit = "mg";

  const posted: { node?: string }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string; inputs?: { patientPlan?: { name: string; doseAmount?: number; doseUnit?: string }[] } };
    posted.push(body);
    if (body.node !== "aiOnPlan") return route.fallback();
    // aiOnPlan's merge rejects a row naming no real Patient Plan action, so echo the canonical label.
    const rows = (body.inputs?.patientPlan ?? []).map((t) => ({
      action: treatmentLabel(t),
      assessment: t.name === marker ? "M66 mock plan assessment" : "regenerated placeholder",
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { rows } }) });
  });

  await page.getByTitle("Add treatment").click();
  // No `administration` in the stub — Unit stays the free-text field this test wants to fill.
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await page.locator(".tedit .field", { hasText: "Amount" }).locator("input").fill(doseAmount);
  await page.locator(".tedit .field", { hasText: "Unit" }).locator("input").fill(doseUnit);
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill(future);
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  const row = page.locator(".unified-treatment .leaf-card", { hasText: marker });
  await expect(row.locator(".ct-assess")).toHaveText("M66 mock plan assessment", { timeout: 10_000 });

});

test("Treatment (Ongoing bucket): editing dose fires the treatmentAssessment trigger with the new dose (M66 P8)", async ({ page }) => {
  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "treatmentAssessment") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items: [] } }) });
  });

  const marker = `M66 ongoing-dose ${Date.now()}`;
  await addOngoingTreatment(page, marker);
  const amount = Date.now() % 100000;
  await gotoTreatmentBucket(page, "Ongoing");
  await doseRowOf(page, marker).click();
  await page.locator(".tedit .field", { hasText: "Amount" }).locator("input").fill(String(amount));
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(() => posted.some((b) => b.node === "treatmentAssessment" && historyOf(b, marker).some((h) => h.doseAmount === amount)), { timeout: 10_000 })
    .toBe(true);
});

// A patient session: the provider-only background sweep would fire treatmentAssessment regardless of the dose gate.
test("Treatment: adding a drug with no dose amount withholds the treatmentAssessment trigger; adding one fires it (M-dose-gates-assessment)", async ({ page }) => {
  await openFreshSynthetic(page);
  await clickNav(page, "Treatment");

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "treatmentAssessment") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items: [] } }) });
  });

  const marker = `M-dosegate ${Date.now()}`;
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-01-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "Ongoing");
  await doseRowOf(page, marker).click();
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("1");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  const assessments = () => posted.filter((b) => b.node === "treatmentAssessment" && historyOf(b, marker).length);
  await expect.poll(() => assessments().length, { timeout: 10_000 }).toBeGreaterThan(0);
  // The dosed save's post is the barrier: a post from the undosed add would have landed before it.
  expect(assessments().flatMap((b) => historyOf(b, marker)).every((h) => h.doseAmount != null)).toBe(true);
});

// The AI-grouped merge is not asserted: no fixture is both fresh and holds a grouped, evaluated hypothesis (W78).
test("Hypothesis: editing an idea fires the hypothesisEvaluation trigger scoped to that idea (M66 P8)", async ({ page }) => {
  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Hypothesis");

  const intervention = `M66 P8 idea ${Date.now()}`;

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "hypothesisEvaluation") return route.fallback();
    const patient = (body.inputs?.patientHypothesis ?? []).map((d) => ({
      intervention: d.intervention,
      // Must satisfy the real validateLeafResult contract: non-empty purpose, 2-8 bullets per field, questions.
      purpose: d.purpose || "a stated purpose",
      pros: d.intervention === intervention ? ["M66 mock pro", "M66 second pro"] : ["regenerated", "regenerated two"],
      cons: d.intervention === intervention ? ["M66 mock con", "M66 second con"] : ["regenerated", "regenerated two"],
      alternatives: ["M66 mock alternative", "M66 second alternative"],
      recommendation: d.intervention === intervention ? "M66 mock recommendation" : "regenerated placeholder",
      questions: ["M66 mock question"],
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { patient } }) });
  });

  await page.getByTitle("Add idea").click();
  await page.locator(".ft-modal .topic-input").fill(intervention);
  await page.locator(".ft-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".future-treatment .saved")).toBeVisible({ timeout: 10_000 });

  const flatRow = page.locator(".future-treatment .leaf-card", { hasText: intervention }).first();
  await clickLeafMenuItem(flatRow, "Edit");
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Edit idea");
  await expect(page.locator(".ft-modal .topic-input")).toHaveValue(intervention);
  // Purpose, not Intervention, so the row keeps its label while its hash moves.
  await page.locator(".ft-modal .ft-input").evaluate((el: HTMLTextAreaElement) => { el.value += " (M66 P8 probe)"; el.dispatchEvent(new Event("input")); });
  await page.locator(".ft-modal .btn.primary", { hasText: "Save" }).click();

  await expect(page.locator(".future-treatment .saved")).toBeVisible({ timeout: 10_000 });

  // The sweep never sends targetLabels; the probe tells the edit's call from the add's.
  const probed = () => posted.filter((b) => b.inputs?.patientHypothesis?.some((d) => d.purpose?.includes("(M66 P8 probe)")));
  await expect.poll(() => scopedLabels(probed(), "hypothesisEvaluation"), { timeout: 10_000 }).toEqual([[intervention]]);
});

// studyResults' merge rejects a group that is not one of the Finding's disease groups.
function realGroup(body: LeafBody): string {
  const group = body.inputs?.aiFindings?.[0]?.group;
  if (!group) throw new Error("leaf-regen mock: no aiFindings group in the request context");
  return group;
}

test("Study: saving an existing entry fires the studyResults trigger; the mocked result merges into the AI column (M66 P8)", async ({ page }) => {
  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Study");

  // Scoped to the AI persona: TurnCard's .rg-col wraps the patient half too.
  const row = page.locator(".study .leaf-card").filter({ has: page.locator(".p-assistant .sr-text") }).first();
  await expect(row).toBeVisible();
  // Strip the permalink button so the label matches the raw focus text the mock compares against.
  const label = (await row.locator(".turn-topic").evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelector("button")?.remove();
    return clone.textContent ?? "";
  })).trim();

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "studyResults") return route.fallback();
    const study = body.inputs?.pursuedStudy ?? {};
    const items: { study: string; result: string; group: string }[] = [];
    const mark = (s: string) => (s === label ? "M66 mock study result" : "regenerated placeholder");
    for (const e of study.entries ?? []) items.push({ study: e.focus, result: mark(e.focus), group: realGroup(body) });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items } }) });
  });

  await clickLeafMenuItem(row, "Edit");
  // The detail text, not the topic, so the row keeps its label while its hash moves.
  await page.locator(".study-modal .sr-input").evaluate((el: HTMLTextAreaElement) => { el.value += " (M66 P8 probe)"; el.dispatchEvent(new Event("input")); });
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();

  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });
  await expect(row.locator(".p-assistant .sr-text")).toHaveText("M66 mock study result", { timeout: 10_000 });

  // The sweep never sends targetLabels, so only the save's call is counted.
  await expect.poll(() => scopedLabels(posted, "studyResults"), { timeout: 10_000 }).toEqual([[label]]);
});

test("Study: adding a brand-new entry scopes the studyResults trigger to just that row via targetLabels, and the mocked result appends (not just updates) into the AI column", async ({ page }) => {
  const marker = `M67 scoped-add ${Date.now()}`;

  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Study");

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "studyResults") return route.fallback();
    // Answering only targetLabels proves the request is scoped: an unscoped one would merge nothing.
    const items = (body.targetLabels ?? []).map((study) => ({ study, result: "M67 mock scoped result", group: realGroup(body) }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items } }) });
  });

  await page.getByTitle("Add study").click();
  await page.locator(".study-modal .topic-input").fill(marker);
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });

  const row = page.locator(".study .leaf-card", { hasText: marker });
  await expect(row.locator(".p-assistant .sr-text")).toHaveText("M67 mock scoped result", { timeout: 10_000 });

  expect(scopedLabels(posted, "studyResults")).toEqual([[marker]]);
});

test("Treatment: adding a brand-new entry scopes the treatmentAssessment trigger to just that row via targetLabels, and the mocked result appends into the AI column", async ({ page }) => {
  const marker = `M68 scoped-add ${Date.now()}`;

  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "treatmentAssessment") return route.fallback();
    const group = body.inputs?.aiFindings?.[0]?.group ?? "Test";
    // The merge requires the treatmentId echoed from the request's own treatmentHistory (W71).
    const history = body.inputs?.treatmentHistory ?? [];
    const items = (body.targetLabels ?? []).map((item) => {
      const t = history.find((h) => item.toLowerCase().includes(h.name.toLowerCase())) ?? history.at(-1);
      return { treatmentId: t?.id ?? "", item, assessment: "M68 mock scoped result", group };
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items } }) });
  });

  await addOngoingTreatment(page, marker);

  const row = page.locator(".unified-treatment .leaf-card", { hasText: marker });
  await expect(row.locator(".p-assistant .ct-assess")).toHaveText("M68 mock scoped result", { timeout: 10_000 });

  expect(scopedLabels(posted, "treatmentAssessment")).toEqual([[marker]]);
});

// A new idea has no treatmentGroups entry to render into, so only the scoped request is observable.
test("Hypothesis: adding a brand-new idea scopes the hypothesisEvaluation trigger to just that intervention via targetLabels", async ({ page }) => {
  const marker = `M68 scoped-idea ${Date.now()}`;

  await openFreshSyntheticAsProvider(page);
  await clickNav(page, "Hypothesis");

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "hypothesisEvaluation") return route.fallback();
    const items = (body.targetLabels ?? []).map((intervention) => ({
      intervention, purpose: "x", pros: [], cons: [], alternatives: [], recommendation: "M68 mock scoped result",
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { patient: items } }) });
  });

  await page.getByTitle("Add idea").click();
  await page.locator(".ft-modal .topic-input").fill(marker);
  await page.locator(".ft-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".future-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => scopedLabels(posted, "hypothesisEvaluation"), { timeout: 10_000 }).toEqual([[marker]]);
});

test("Treatment: a Translate that fails states the reason inline, in red, and clears the busy label", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");

  await page.route("**/api/leaf-regen", (route) =>
    route.fulfill({
      status: 402,
      contentType: "application/json",
      body: JSON.stringify({ error: "AI is temporarily unavailable: the account is out of credits.", errorCode: "insufficient_credit" }),
    }),
  );

  await gotoTreatmentBucket(page, "Ongoing");
  const group = page.locator(".unified-treatment .leaf-card").first();
  await clickLeafMenuItem(group, "Translate");

  const reason = group.locator(".translate-error");
  await expect(reason).toHaveText(/out of credits/, { timeout: 15_000 });
  await expect(group.locator(".translate-note")).toHaveCount(0);
  // Same --alert red the rest of the app uses for a failure, not a muted note.
  await expect(reason).toHaveCSS("color", await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--alert)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }));
});

// A patient session: the provider-only sweep would post treatmentGroups on any treatment edit.
test("Treatment (Planned bucket): re-extracting a unit change fires treatmentGroups; an unrelated entry-scope save does not", async ({ page }) => {
  await openFreshSynthetic(page);
  await clickNav(page, "Treatment");

  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    const result = body.node === "treatmentAssessment" ? { items: [] } : { groups: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) });
  });
  const groupPosts = () => posted.filter((b) => b.node === "treatmentGroups").length;

  const marker = `M-relabel-regen ${Date.now()}`;
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name: marker, kind: "drug" });
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("5");
  await page.locator(".tedit .field", { hasText: "Unit" }).locator("input").fill("mg");
  await page.locator(".tedit .field", { hasText: "Frequency" }).locator("select").selectOption("day");
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill(future);
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await gotoTreatmentBucket(page, "All");
  const card = page.locator(".med-group", { hasText: marker });

  await clickLeafMenuItem(card, "Edit");
  await identifyTreatmentByText(page, {
    name: marker,
    kind: "drug",
    administration: { unit: "tablet", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" },
  });
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });
  await expect.poll(groupPosts, { timeout: 10_000 }).toBe(1);

  await doseRowOf(page, marker).click();
  await page.locator(".tedit .field", { hasText: "Reason" }).locator("input").fill("unrelated edit");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });
  // A forced treatmentGroups skips hashing, so it would post before this save's treatmentAssessment.
  await expect
    .poll(() => posted.some((b) => b.node === "treatmentAssessment" && historyOf(b, marker).some((h) => h.reason === "unrelated edit")), { timeout: 10_000 })
    .toBe(true);
  expect(groupPosts()).toBe(1);
});
