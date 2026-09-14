import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openAsProvider } from "./_login";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { unlock, gotoTreatmentBucket, identifyTreatmentByText, addOngoingTreatment, editFirstDoseEntry } from "./_shell";
import { treatmentLabel } from "@pablotech/akesi-pil/treatment-bucket";

// The /api/leaf-regen relay, from the UI side (M66 P8, M68).
//
// One shape, five triggers: save something, and exactly one relay call goes out for the node that
// save invalidated — treatmentGroups, aiOnPlan, treatmentAssessment, hypothesisEvaluation or
// studyResults — whose mocked result merges into the AI column. "Without double-posting" is in most
// of the names because the recurring bug was two calls, not none.
//
// The three `targetLabels` tests are the M68 half: adding a brand-new row must scope the trigger to
// that row and APPEND to the AI column rather than update whatever was already there.
//
// W74 — one of the seven files `shell-nav.spec.ts` became. It was 1437 lines and 53 tests, and
// `--shard` partitions by FILE: whichever shard held it ran ~56 tests against a single workerd while
// every other shard ran 19, which made it the gate's chronic red. Helpers shared by more than one of
// the seven live in `_shell.ts`; a helper with one caller stayed with its caller.

// The dose row belonging to one named medicine, rather than whichever row happens to be first.
function doseRowOf(page: Page, name: string) {
  return page.locator(".med-group", { hasText: name }).locator(".med-table td.med-actions .btn", { hasText: "Edit" }).first();
}

// M66 P8 — regression coverage for the treatmentGroups leaf-regen refactor: it used to be the only
// node behind /api/regroup, and is now one of five sharing the generic /api/leaf-regen relay. Reuses
// the exact stale-arming idiom from the M55/M56 race test above (a dose-only edit leaves
// treatmentGroups the sole stale node) but asserts directly on the posted `node` field instead of
// just delaying the response, proving the refactor still routes this legacy node correctly.
test("a dose-only Treatment edit still fires treatmentGroups through the generic /api/leaf-regen relay (M66 P8 regression)", async ({ page }) => {
  const posted: { node?: string }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string };
    posted.push(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { groups: [] } }) });
  });

  await openAsProvider(page, "Blair");
  await clickNav(page, "Treatment");
  await gotoTreatmentBucket(page, "Ongoing");
  await editFirstDoseEntry(page);
  await page.locator(".tedit .field", { hasText: "Amount" }).locator("input").fill(String(Date.now()));
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => posted.some((b) => b.node === "treatmentGroups"), { timeout: 10_000 }).toBe(true);
});

// M66 P8 — the four newly-registered leaf-regen nodes (Phase 6/7), each fired from its own save
// site's onTriggerRegen call (App.svelte's generalized effect + triggerLeafRegen). Every test here
// intercepts the shared /api/leaf-regen relay, asserts the correct `node` was posted, and confirms
// the mocked response actually merges into the visible UI — not just that a request happened. Where
// the node's mergeInto only updates existing entries matched by an exact label (treatmentAssessment),
// the mock echoes back whatever the request itself sent (never a hardcoded guess at PHI content), so
// nothing is silently invented and no full-array-replace node (aiOnPlan/hypothesisEvaluation) drops
// coverage of a sibling entry it isn't testing.

test("Treatment (Planned bucket): Add fires the aiOnPlan trigger; the mocked plan assessment merges into the read view, without double-posting (M66 P8)", async ({ page }) => {
  // deleteTreatment gates on a native confirm() — Playwright auto-dismisses that unless accepted,
  // which silently no-ops the cleanup Delete below and leaves this test's marker treatment in
  // Alex's real vault permanently. Must be registered before the Delete click fires the dialog.
  page.on("dialog", (d) => d.accept());
  await openAsProvider(page, "Blair");
  await clickNav(page, "Treatment");

  const marker = `M66 plan rx ${Date.now()}`;
  const doseAmount = "10";
  const doseUnit = "mg";

  const posted: { node?: string }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string; inputs?: { patientPlan?: { name: string; doseAmount?: number; doseUnit?: string }[] } };
    posted.push(body);
    if (body.node !== "aiOnPlan") return route.fallback();
    // W65 — the action must be the CANONICAL label (treatmentLabel: name + formatDose, frequency
    // included), because aiOnPlan's merge now rejects a row naming no real Patient Plan action —
    // the rule finding-assemble.ts:523 already applied to the monolith. This mock's hand-rolled
    // `name + amount + unit` dropped the frequency, so it named an action that does not exist.
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

  await page.waitForTimeout(1500);
  // W76 — a BOUND, not an exact count, and the bound is the honest limit of what this test can see.
  //
  // Two posts for this node in this scenario are both legitimate: the unprompted on-open sweep
  // regenerates it because the fixture opens stale, and the save above then asks for it again with a
  // different input. Until W75 the save's request was silently DROPPED whenever it landed while the
  // sweep's was still in flight, so a total of 1 meant "the user's edit got no answer" rather than
  // "no double-post" — the exact-count assertion was pinning that bug, and it failed on a loaded CI
  // shard for precisely that reason (the sweep's hashing is slow enough that its POST lands after
  // the click). This node carries no targetLabels, so the save's call cannot be told from the
  // sweep's the way the scoped assertions below do it.
  //
  // What the bound still catches is the failure a count assertion is really for: a regen that loops.
  // "Exactly one call per distinct input signature" is decidable only against the queue itself, and
  // is asserted in tests/unit/leaf-regen-queue.test.ts.
  const planPosts = posted.filter((b) => b.node === "aiOnPlan").length;
  expect(planPosts).toBeGreaterThanOrEqual(1);
  expect(planPosts).toBeLessThanOrEqual(2);

  await clickLeafMenuItem(row, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

test("Treatment (Ongoing bucket): editing dose fires the treatmentAssessment trigger, without double-posting (M66 P8)", async ({ page }) => {
  await openAsProvider(page, "Blair");
  await clickNav(page, "Treatment");

  const posted: { node?: string }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string };
    posted.push(body);
    if (body.node !== "treatmentAssessment") return route.fallback();
    // Empty on purpose: this test is about the trigger/route wiring, and the merge itself is covered
    // by leaf-regen-registry.test.ts.
    //
    // W71 note — this used to say a match "isn't derivable from the network-visible TreatmentItem
    // shape sent here". That stopped being true when treatmentAssessment moved to id pairing: the
    // request's treatmentHistory carries each id, so a mock CAN now answer a specific row without
    // reading any PHI file (the scoped-add test above does exactly that).
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items: [] } }) });
  });

  const marker = `M66 ongoing-dose ${Date.now()}`;
  await addOngoingTreatment(page, marker);
  // Adding the treatment is itself a treatmentAssessment trigger; this test is about the EDIT, so
  // let the add's own regen land and then start counting from zero.
  await expect.poll(() => posted.some((b) => b.node === "treatmentAssessment"), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1500);
  posted.length = 0;
  await gotoTreatmentBucket(page, "Ongoing");
  await doseRowOf(page, marker).click();
  await page.locator(".tedit .field", { hasText: "Amount" }).locator("input").fill(String(Date.now() % 100000));
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => posted.some((b) => b.node === "treatmentAssessment"), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1500);
  // Same bound, same reason as the aiOnPlan assertion above: the on-open sweep asks for every
  // sweepable node, and this add sends no targetLabels to tell the two calls apart.
  const assessPosts = posted.filter((b) => b.node === "treatmentAssessment").length;
  expect(assessPosts).toBeGreaterThanOrEqual(1);
  expect(assessPosts).toBeLessThanOrEqual(2);

  // Clean up, like the scoped-add test below. These specs share one local vault; a treatment left
  // behind accumulates across runs and eventually shifts the sidebar enough to fail an unrelated
  // spec (sidebar-group-expand's Ongoing children), which is a miserable failure to trace back here.
  page.on("dialog", (d) => d.accept());
  await gotoTreatmentBucket(page, "All");
  await clickLeafMenuItem(page.locator(".unified-treatment .leaf-card", { hasText: marker }), "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// M-dose-gates-assessment — treatmentAssessment now withholds its own explicit trigger until the
// drug has a dose on file, on top of (not instead of) the staleness gate the test above exercises.
// A patient session, for the same reason the unit-change test further below needs one: the
// provider-gated background sweep also watches treatmentAssessment (it's in LEAF_REGEN_NODES) and
// would fire it regardless of the dose gate once treatmentHistory's hash moves, confounding an
// absence assertion in a provider session.
test("Treatment: adding a drug with no dose amount withholds the treatmentAssessment trigger; adding one fires it (M-dose-gates-assessment)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await unlock(page, "Blair");
  await clickNav(page, "Treatment");

  const posted: { node?: string }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string };
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

  // No Amount was ever entered for this drug — hasAnyDose() must withhold the trigger.
  await page.waitForTimeout(1500);
  expect(posted.some((b) => b.node === "treatmentAssessment")).toBe(false);

  await gotoTreatmentBucket(page, "Ongoing");
  await doseRowOf(page, marker).click();
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("1");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => posted.some((b) => b.node === "treatmentAssessment"), { timeout: 10_000 }).toBe(true);

  await gotoTreatmentBucket(page, "All");
  await clickLeafMenuItem(page.locator(".unified-treatment .leaf-card", { hasText: marker }), "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// W78 — this used to also assert that the mocked pros/cons/recommendation MERGED into the read-only
// AI-grouped view, by borrowing an idea that already carried an AI take out of Alex's vault. That
// half is not expressible against either fixture any more, and is dropped rather than faked: Alex's
// vault reads stale on markerLevels/aiFindings since the 2026-08-26 reconcile, so `regen()` skips
// every leaf and NOTHING posts (measured: zero requests); and on Blair, where the regen does fire, the
// grouped view is built from the Finding's stored grouping, so an idea this test adds never enters
// it (measured). Restoring it needs a fixture that is fresh AND holds a grouped, evaluated
// hypothesis — which is W78's subject.
test("Hypothesis: editing an idea fires the hypothesisEvaluation trigger scoped to that idea (M66 P8)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openAsProvider(page, "Blair");
  await clickNav(page, "Hypothesis");

  const intervention = `M66 P8 idea ${Date.now()}`;

  const posted: { node?: string; targetLabels?: string[] }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string; targetLabels?: string[]; inputs?: { patientHypothesis?: { intervention: string; purpose?: string }[] } };
    posted.push(body);
    if (body.node !== "hypothesisEvaluation") return route.fallback();
    const patient = (body.inputs?.patientHypothesis ?? []).map((d) => ({
      intervention: d.intervention,
      // This payload goes through the REAL validateLeafResult, so it has to satisfy the real contract,
      // not a convenient sketch of it. Purpose non-empty, 2-8 non-empty bullets per field (W67, mirroring
      // finding-assemble.ts:298-320), and questions present (W66, since the leaf owns
      // doctorConversation's patient band). A payload short of any of these is rejected — which is the
      // point, but it means this mock has to be updated whenever the contract tightens.
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
  // The add fires a scoped call of its own — asserted by its own test below; count from the EDIT.
  await page.waitForTimeout(1500);
  posted.length = 0;

  const flatRow = page.locator(".future-treatment .leaf-card", { hasText: intervention }).first();
  await clickLeafMenuItem(flatRow, "Edit");
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Edit idea");
  await expect(page.locator(".ft-modal .topic-input")).toHaveValue(intervention);
  // Append a marker to Purpose (leave Intervention text untouched, so `intervention` still matches
  // this same row's label) — patientHypothesis's canonical hash covers both fields, so this is what
  // actually makes hypothesisEvaluation go stale for this save.
  await page.locator(".ft-modal .ft-input").evaluate((el: HTMLTextAreaElement) => { el.value += " (M66 P8 probe)"; el.dispatchEvent(new Event("input")); });
  await page.locator(".ft-modal .btn.primary", { hasText: "Save" }).click();

  await expect(page.locator(".future-treatment .saved")).toBeVisible({ timeout: 10_000 });

  await page.waitForTimeout(1500);
  // W76 — assert the SAVE's call, not the total for the node.
  //
  // Two calls for hypothesisEvaluation in this scenario is honest, not a bug: the unprompted on-open
  // sweep regenerates it because the fixture opens stale, and the edit below then supersedes what
  // that call was about. Until W75 the save's own request was silently DROPPED whenever it landed
  // while the sweep's was still in flight, so a total of 1 looked like "no double-post" while it
  // actually meant "the user's edit got no answer at all" — this test was asserting the bug.
  //
  // What this assertion can still see is the save's OWN call — the one carrying targetLabels, which
  // the sweep never sends — and that it is scoped to the row just edited. It cannot see the
  // regression that motivated the split, because the after-a-save sweep posts without targetLabels;
  // that half is asserted where it is decidable, by the source-grep over App.svelte's two effects in
  // tests/unit/leaf-regen-queue.test.ts. Nor can it see a doubled trigger from the editor: the
  // queue's own signature dedupe collapses one (verified by mutation — a second call with a
  // different label still yields one post). Both are unit-testable properties and are unit-tested.
  const scoped = posted.filter((b) => b.node === "hypothesisEvaluation" && b.targetLabels?.length);
  expect(scoped.length).toBe(1);
  expect(scoped[0].targetLabels).toEqual([intervention]);

  await clickLeafMenuItem(flatRow, "Delete");
  await expect(page.locator(".future-treatment")).not.toContainText(intervention);
});

// W65 — studyResults' merge now rejects a body-system tag that is not one of the Finding's disease
// groups, the same rule finding-assemble.ts:218 applies when the monolith writes the section. These
// mocks used the literal "Test", which that rule (rightly) refuses.
function realGroup(body: { inputs?: { aiFindings?: { group: string }[] } }): string {
  const group = body.inputs?.aiFindings?.[0]?.group;
  if (!group) throw new Error("leaf-regen mock: no aiFindings group in the request context");
  return group;
}

test("Study: saving an existing entry fires the studyResults trigger; the mocked result merges into the AI column, without double-posting (M66 P8)", async ({ page }) => {
  await openAsProvider(page, "Blair");
  await clickNav(page, "Study");

  // Any row (a named entry) that already shows an AI result. Scoped to the AI PERSONA, not to
  // `.rg-col`: TurnCard wraps BOTH halves in a column (the shape every section shares now), where
  // Study's old markup wrapped only the AI side — so `.rg-col .sr-text` matches the patient's text
  // too and would assert against the wrong half.
  const row = page.locator(".study .leaf-card").filter({ has: page.locator(".p-assistant .sr-text") }).first();
  await expect(row).toBeVisible();
  // .turn-topic (TurnCard's shared title, formerly Study's own .sr-topic) wraps a HeadingAnchor,
  // whose permalink-grab button (🔗) is part of the same span's
  // innerText — strip it so `label` matches the raw `study`/`focus` text the mock compares against.
  const label = (await row.locator(".turn-topic").evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelector("button")?.remove();
    return clone.textContent ?? "";
  })).trim();

  const posted: { node?: string; targetLabels?: string[] }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as {
      node?: string;
      targetLabels?: string[];
      // aiFindings IS finding.disease (leaf-regen-registry.ts:31) — the body carries the real body
      // systems, so the mock can tag with one instead of inventing a name the app would reject.
      inputs?: { pursuedStudy?: { entries?: { focus: string }[] }; aiFindings?: { group: string }[] };
    };
    posted.push(body);
    if (body.node !== "studyResults") return route.fallback();
    const study = body.inputs?.pursuedStudy ?? {};
    const items: { study: string; result: string; group: string }[] = [];
    const mark = (s: string) => (s === label ? "M66 mock study result" : "regenerated placeholder");
    for (const e of study.entries ?? []) items.push({ study: e.focus, result: mark(e.focus), group: realGroup(body) });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items } }) });
  });

  await clickLeafMenuItem(row, "Edit");
  // pursuedStudy's canonical hash covers the entry's detail text, not just the topic
  // label — appending to it is what actually makes studyResults go stale for this save.
  await page.locator(".study-modal .sr-input").evaluate((el: HTMLTextAreaElement) => { el.value += " (M66 P8 probe)"; el.dispatchEvent(new Event("input")); });
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();

  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });
  await expect(row.locator(".p-assistant .sr-text")).toHaveText("M66 mock study result", { timeout: 10_000 });

  await page.waitForTimeout(1500);
  // W76 — assert the SAVE's call, not the total for the node.
  //
  // Two calls for studyResults in this scenario is honest, not a bug: the unprompted on-open
  // sweep regenerates it because the fixture opens stale, and the edit below then supersedes what
  // that call was about. Until W75 the save's own request was silently DROPPED whenever it landed
  // while the sweep's was still in flight, so a total of 1 looked like "no double-post" while it
  // actually meant "the user's edit got no answer at all" — this test was asserting the bug.
  //
  // What this assertion can still see is the save's OWN call — the one carrying targetLabels, which
  // the sweep never sends — and that it is scoped to the row just edited. It cannot see the
  // regression that motivated the split, because the after-a-save sweep posts without targetLabels;
  // that half is asserted where it is decidable, by the source-grep over App.svelte's two effects in
  // tests/unit/leaf-regen-queue.test.ts. Nor can it see a doubled trigger from the editor: the
  // queue's own signature dedupe collapses one (verified by mutation — a second call with a
  // different label still yields one post). Both are unit-testable properties and are unit-tested.
  const scoped = posted.filter((b) => b.node === "studyResults" && b.targetLabels?.length);
  expect(scoped.length).toBe(1);
  expect(scoped[0].targetLabels).toEqual([label]);
});

test("Study: adding a brand-new entry scopes the studyResults trigger to just that row via targetLabels, and the mocked result appends (not just updates) into the AI column", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M67 scoped-add ${Date.now()}`;

  await openAsProvider(page, "Blair");
  await clickNav(page, "Study");

  const posted: { node?: string; targetLabels?: string[] }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string; targetLabels?: string[]; inputs?: { aiFindings?: { group: string }[] } };
    posted.push(body);
    if (body.node !== "studyResults") return route.fallback();
    // Answering ONLY the row(s) named in targetLabels (never the rest of Alex's real Study list)
    // proves the request is genuinely scoped — an unscoped mock would need to enumerate every row.
    const items = (body.targetLabels ?? []).map((study) => ({ study, result: "M67 mock scoped result", group: realGroup(body) }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items } }) });
  });

  await page.getByTitle("Add study").click();
  await page.locator(".study-modal .topic-input").fill(marker);
  await page.locator(".study-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".study .saved")).toBeVisible({ timeout: 10_000 });

  const row = page.locator(".study .leaf-card", { hasText: marker });
  await expect(row.locator(".p-assistant .sr-text")).toHaveText("M67 mock scoped result", { timeout: 10_000 });

  await page.waitForTimeout(1500);
  // Filtered on targetLabels, which the sweep never sends — so this counts the SAVE's call only.
  const studyPosts = posted.filter((b) => b.node === "studyResults" && b.targetLabels?.length);
  expect(studyPosts.length).toBe(1);
  expect(studyPosts[0].targetLabels).toEqual([marker]);

  await clickLeafMenuItem(row, "Delete");
  await expect(page.locator(".study")).not.toContainText(marker);
});

// M68 P5 — the same append+scope loop Study proved above, mirrored for treatmentAssessment (the
// other row-addressable node newly wired to targetLabels this milestone). The mocked group is echoed
// back from the request's own posted `inputs.aiFindings` (the client's real finding.disease groups)
// rather than a hardcoded name, since mergeInto's group-membership check requires a group that's
// actually current for this patient.
test("Treatment: adding a brand-new entry scopes the treatmentAssessment trigger to just that row via targetLabels, and the mocked result appends into the AI column", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M68 scoped-add ${Date.now()}`;

  await openAsProvider(page, "Blair");
  await clickNav(page, "Treatment");

  type LeafBody = {
    node?: string;
    targetLabels?: string[];
    inputs?: { aiFindings?: { group: string }[]; treatmentHistory?: { id: string; name: string }[] };
  };
  const posted: LeafBody[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as LeafBody;
    posted.push(body);
    if (body.node !== "treatmentAssessment") return route.fallback();
    const group = body.inputs?.aiFindings?.[0]?.group ?? "Test";
    // W71 — echo the treatmentId, as the real model is now required to. Taken from the request's own
    // treatmentHistory, which is where the model reads it too: a mock that invents one would be
    // rejected for exactly the right reason, and a mock that omits it tests nothing.
    const history = body.inputs?.treatmentHistory ?? [];
    // Answering ONLY the row(s) named in targetLabels proves the request is genuinely scoped.
    const items = (body.targetLabels ?? []).map((item) => {
      const t = history.find((h) => item.toLowerCase().includes(h.name.toLowerCase())) ?? history.at(-1);
      return { treatmentId: t?.id ?? "", item, assessment: "M68 mock scoped result", group };
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items } }) });
  });

  await addOngoingTreatment(page, marker);

  const row = page.locator(".unified-treatment .leaf-card", { hasText: marker });
  await expect(row.locator(".p-assistant .ct-assess")).toHaveText("M68 mock scoped result", { timeout: 10_000 });

  await page.waitForTimeout(1500);
  // Filtered on targetLabels, which the sweep never sends — so this counts the SAVE's call only.
  const taPosts = posted.filter((b) => b.node === "treatmentAssessment" && b.targetLabels?.length);
  expect(taPosts.length).toBe(1);
  expect(taPosts[0].targetLabels).toEqual([marker]);

  await clickLeafMenuItem(row, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});

// M68 P5 — mirrored for hypothesisEvaluation. Unlike Study/Treatment, a brand-new idea isn't placed
// in any finding.treatmentGroups entry yet (that's a separate, unscoped regen), so FutureTreatment's
// read view has nowhere to display the merged decisions.patient text for it — the assertion is
// scoped to what's actually observable: the request is genuinely scoped (targetLabels === the new
// idea's own intervention) and exactly one request fires, with no exception surfacing from the save.
test("Hypothesis: adding a brand-new idea scopes the hypothesisEvaluation trigger to just that intervention via targetLabels", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M68 scoped-idea ${Date.now()}`;

  await openAsProvider(page, "Blair");
  await clickNav(page, "Hypothesis");

  const posted: { node?: string; targetLabels?: string[] }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string; targetLabels?: string[] };
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

  await page.waitForTimeout(1500);
  // W76 — assert the SAVE's call, not the total for the node.
  //
  // Two calls for hypothesisEvaluation in this scenario is honest, not a bug: the unprompted on-open
  // sweep regenerates it because the fixture opens stale, and the edit below then supersedes what
  // that call was about. Until W75 the save's own request was silently DROPPED whenever it landed
  // while the sweep's was still in flight, so a total of 1 looked like "no double-post" while it
  // actually meant "the user's edit got no answer at all" — this test was asserting the bug.
  //
  // What this assertion can still see is the save's OWN call — the one carrying targetLabels, which
  // the sweep never sends — and that it is scoped to the row just edited. It cannot see the
  // regression that motivated the split, because the after-a-save sweep posts without targetLabels;
  // that half is asserted where it is decidable, by the source-grep over App.svelte's two effects in
  // tests/unit/leaf-regen-queue.test.ts. Nor can it see a doubled trigger from the editor: the
  // queue's own signature dedupe collapses one (verified by mutation — a second call with a
  // different label still yields one post). Both are unit-testable properties and are unit-tested.
  const hypPosts = posted.filter((b) => b.node === "hypothesisEvaluation" && b.targetLabels?.length);
  expect(hypPosts.length).toBe(1);
  expect(hypPosts[0].targetLabels).toEqual([marker]);

  const row = page.locator(".future-treatment .leaf-card", { hasText: marker });
  await clickLeafMenuItem(row, "Delete");
  await expect(page.locator(".future-treatment")).not.toContainText(marker);
});

// The reported bug, as an acceptance test: a Translate that cannot succeed must STOP and say why.
// Before this, fetchLeafRegen had no deadline and no signal, so a relay that never answered left
// "Translating…" on screen forever with no reason anywhere — and a relay that answered 402 rendered
// its raw JSON body instead of the credit sentence used everywhere else.
test("Treatment: a Translate that fails states the reason inline, in red, and clears the busy label", async ({ page }) => {
  await openAsProvider(page, "Blair");
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

// The regen-trigger side of the doseUnit reconciliation (M-doseunit-relabel): relabeling doseUnit
// changes every row's treatmentLabel() (name+dose, unit included), which stale-matches the
// finding.treatmentGroups[].patient[] ref resolvePatientRef persisted under the OLD label for a
// currently-planned row. Only a real unit change should pay for the forced full regen — an
// unrelated medicine-scope save (Reason only) must not.
// A patient session, not a provider one: factors-hash.ts's treatmentCanonical deliberately folds
// EVERY treatment field (including Reason) into one signature, so ANY edit already leaves
// treatmentGroups looking stale, and App.svelte's provider-gated background sweep would pick that
// staleness up and post a treatmentGroups regen of its own — indistinguishable, over the wire,
// from the one this test wants to attribute to the explicit force call. Patient sessions never run
// that sweep (leaf-regen-queue.svelte.ts's sweep() bails without a provider token), so the only
// possible source of a treatmentGroups post here is the explicit onTriggerRegen call this
// milestone added.
test("Treatment (Planned bucket): re-extracting a unit change fires treatmentGroups; an unrelated entry-scope save does not", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await unlock(page, "Blair");
  await clickNav(page, "Treatment");

  const posted: { node?: string }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as { node?: string };
    posted.push(body);
    const result = body.node === "treatmentAssessment" ? { items: [] } : { groups: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) });
  });

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
  // The add itself is a treatmentAssessment trigger; let it land before counting from zero.
  await expect.poll(() => posted.some((b) => b.node === "treatmentAssessment"), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1500);
  posted.length = 0;

  await gotoTreatmentBucket(page, "All");
  const card = page.locator(".med-group", { hasText: marker });

  // First attach of administration — a real unit change from nothing — must force the regen.
  await clickLeafMenuItem(card, "Edit");
  await identifyTreatmentByText(page, {
    name: marker,
    kind: "drug",
    administration: { unit: "tablet", unitsPerServing: 1, suggestedUnits: 1, suggestedFrequency: "day" },
  });
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => posted.some((b) => b.node === "treatmentGroups"), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1500);
  posted.length = 0;

  // An unrelated entry-scope save — Reason only, administration/unit untouched — must NOT.
  // M-reason-in-dose-editor moved Reason out of the medicine-scope form entirely, so the
  // "unrelated save" that used to reuse the card's medicine-scope Edit now has to be a dose-row
  // edit instead — that's the only place Reason is still editable.
  await doseRowOf(page, marker).click();
  await page.locator(".tedit .field", { hasText: "Reason" }).locator("input").fill("unrelated edit");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => posted.some((b) => b.node === "treatmentAssessment"), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1500);
  expect(posted.some((b) => b.node === "treatmentGroups")).toBe(false);

  await clickLeafMenuItem(card, "Delete");
  await expect(page.locator(".unified-treatment")).not.toContainText(marker);
});
