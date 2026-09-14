import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openAsProvider, hashOf } from "./_login";
import { clickLeafMenuItem } from "./_leaf-menu";
import { stubChatHistory } from "./_stubs";
import { search } from "./_search";
import { clickNav } from "./_nav";

// Split out of search.spec.ts (W76): a hosted 2-vCPU/7-GB runner kills workerd partway through a long
// spec, and `--shard` partitions by FILE, so one oversized file sets the floor for every slice.
// This half: the kinds that carry structure — markers and their chart, Analysis bubbles, chat
// threads, treatments, hypotheses, exploration cells.

test("sidebar search finds a marker and renders a real chart (M85 Phase 6)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await search(page, "Apolipoprotein B");
  // Exact heading match: "Recommended Markers" is its own search group now, and a plain
  // hasText:"Markers" filter matches both.
  const markersGroup = page
    .locator(".search-results .search-group")
    .filter({ has: page.getByRole("heading", { name: "Markers", exact: true }) });
  await expect(markersGroup).toBeVisible();

  // Scoped to the Markers group specifically: Glossary results are `.leaf-card` too since W62, and
  // a glossary term matching this marker's name sorted above it would otherwise win the .first().
  const chart = markersGroup.locator(".leaf-card", { hasText: "Apolipoprotein B" }).first();
  await expect(chart).toBeVisible();
  await expect(chart.locator(".marker-name")).toHaveText("Apolipoprotein B");

  await clickLeafMenuItem(chart, "Details");
  await expect(page).toHaveURL(new RegExp(`${hashOf.Pablo}/markers`));
  await expect(page.locator(".markers-tab .permalink-flash")).toBeVisible({ timeout: 5_000 });
});

test("sidebar search finds an Analysis bubble by its text (M85 Phase 8)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  // W78 — the phrase is READ OFF the card it is meant to find. It used to be a literal ("SERM
  // Enclomiphene") lifted from the prose of one regen of one patient's Finding, re-confirmed by hand
  // after each regen until the 2026-08-26 one dropped it and the search simply returned nothing.
  // Six consecutive words out of the passage cannot go stale that way.
  await clickNav(page, "Analysis");
  const source = page.locator(".analysis .leaf-card", { hasText: "Final Thoughts" }).first();
  const phrase = (await source.locator(".an-text").first().innerText()).trim().split(/\s+/).slice(2, 8).join(" ");
  await search(page, phrase);
  const analysisGroup = page.locator(".search-results .search-group", { hasText: "Analysis" });
  await expect(analysisGroup).toBeVisible();
  // W62 — two deliberate changes land here. The hit is a `.leaf-card` now, not a bare
  // `.persona-bubble`: SearchPanel renders the shared AnalysisItemCard, so a search result and the
  // Analysis section show the same cell. And the label is "Final Thoughts", not "Final thoughts" —
  // search used to re-derive its own labels and had drifted from the app's on three items.
  const hit = analysisGroup.locator(".leaf-card", { hasText: "Final Thoughts" }).first();
  await expect(hit).toBeVisible();
  await clickLeafMenuItem(hit, "Open");

  await expect(page).toHaveURL(new RegExp(`${hashOf.Pablo}/analysis`));
  await expect(page.locator(".analysis .permalink-flash")).toBeVisible({ timeout: 5_000 });
});

function stubChat(page: Page, answer: string) {
  return page.route("**/api/chat", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer }) }),
  );
}

async function ask(page: Page, q: string) {
  await page.fill(".chat-tab textarea", q);
  await page.click(".chat-tab button.send");
}

test("sidebar search finds a chat thread by its title (first message) (M85)", async ({ page }) => {
  await stubChatHistory(page);
  await openAsProvider(page, "Pablo");
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });
  const marker = `M85 chat title ${Date.now()}`;
  await stubChat(page, "Acknowledged.");
  await ask(page, marker);
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toBeVisible({ timeout: 10_000 });

  await search(page, marker);
  await expect(page.locator(".search-results .search-group", { hasText: "Chat" })).toBeVisible();
  const threadRow = page.locator(".search-results .leaf-card", { hasText: marker }).first();
  await clickLeafMenuItem(threadRow, "Open");
  await expect(page.locator(".p-owner .turn-text", { hasText: marker })).toBeVisible();
});

test("sidebar search finds a treatment and auto-selects its bucket (M85 Phase 7)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  // Tirzepatide is one of Pablo's real ongoing drugs (see shell-treatment.spec.ts's Treatment test), but the
  // name also appears inside real Finding prose (ranges rationale, futureTreatment/docInference text,
  // and — since M85 Phase 8 — Analysis' On Treatment bubble, whose "On Treatment" context chip makes a
  // plain hasText:"Treatment" match the Analysis group too) — scope to the group whose heading is
  // exactly "Treatment", not just a group containing that substring.
  await search(page, "Tirzepatide");
  const treatmentGroup = page.locator(".search-results .search-group").filter({ has: page.locator("h3", { hasText: /^Treatment$/ }) });
  await expect(treatmentGroup).toBeVisible();
  const row = treatmentGroup.locator(".leaf-card", { hasText: "Tirzepatide" }).first();
  await expect(row).toBeVisible();
  await clickLeafMenuItem(row, "Open");

  await expect(page).toHaveURL(new RegExp(`${hashOf.Pablo}/treatment`));
  await expect(page.locator(".unified-treatment .permalink-flash")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "Ongoing" })).toHaveClass(/active/);
});

test("sidebar search finds a hypothesis topic and auto-selects its system group (M85 Phase 7)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  // Real seeded topic/system pair for Pablo (finding.treatmentGroups) — the 2-token query is
  // specific enough to avoid the cross-section name collisions found in the Treatment test above.
  // M96 Phase 10 regen: re-confirmed against the current Finding's treatmentGroups.
  await search(page, "Lipid-lowering Rosuvastatin");
  const hypothesisGroup = page.locator(".search-results .search-group", { hasText: "Hypothesis" });
  await expect(hypothesisGroup).toBeVisible();
  const topicCard = hypothesisGroup.locator(".leaf-card", { hasText: "Rosuvastatin" }).first();
  // M103 — the "Lipid-lowering" topic has one patient idea and 3 AI ideas (Rosuvastatin,
  // Bempedoic acid, PCSK9 inhibitor); only "Rosuvastatin" contains the search string, so the
  // scoped preview must show just that one idea, not its siblings in the same topic.
  await expect(topicCard.getByText("Bempedoic acid", { exact: false })).toHaveCount(0);
  await expect(topicCard.getByText("PCSK9 inhibitor", { exact: false })).toHaveCount(0);
  await clickLeafMenuItem(topicCard, "Open");

  await expect(page).toHaveURL(new RegExp(`${hashOf.Pablo}/futureTreatment`));
  await expect(page.locator(".future-treatment .permalink-flash")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "Cardiovascular Risk" })).toHaveClass(/active/);
});

test("sidebar search finds one item within a multi-item exploration cell and scopes the preview to it (M103)", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  // Real seeded dataRequisition cell for Pablo: type "Scan / Imaging", group "Cardiovascular Risk"
  // has 3 items (CAC, echocardiogram, aortic imaging) — search a string unique to just the
  // echocardiogram item and confirm the preview scopes to that ONE item.
  // W61 — an exploration item is its own LeafCard now (modality in the card title, item text in a
  // single AI bubble) rather than one <li> among siblings inside a shared bubble.
  await search(page, "echocardiogram");
  const explorationGroup = page.locator(".search-results .search-group", { hasText: "Exploration" });
  await expect(explorationGroup).toBeVisible();
  const cell = explorationGroup.locator(".leaf-card", { hasText: "Scan / Imaging" }).first();
  await expect(cell).toBeVisible();
  // Exactly one item card, and it is the matched one — not its two siblings.
  await expect(explorationGroup.locator(".leaf-card")).toHaveCount(1);
  // Case-insensitive: the passage capitalises it ("Repeat Transthoracic Echocardiogram …"), and the
  // search that found it is case-insensitive too — matching only lowercase asserted the prose's
  // capitalisation, which is not this test's subject.
  await expect(cell.locator(".persona-bubble.p-assistant")).toContainText(/echocardiogram/i);
  await clickLeafMenuItem(cell, "Open");

  await expect(page).toHaveURL(new RegExp(`${hashOf.Pablo}/exploration`));
  await expect(page.locator(".tests-consider .permalink-flash")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: "Cardiovascular Risk" })).toHaveClass(/active/);
});

test("sidebar search finds a chat thread by a later message's text, not just its title (M85)", async ({ page }) => {
  await stubChatHistory(page);
  await openAsProvider(page, "Pablo");
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });
  await stubChat(page, "Ack 1");
  await ask(page, "an unrelated first question");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toBeVisible({ timeout: 10_000 });

  const marker = `M85 chat followup ${Date.now()}`;
  await stubChat(page, "Ack 2");
  await ask(page, marker);
  await expect(page.locator(".p-owner .turn-text", { hasText: marker })).toBeVisible();

  await search(page, marker);
  await expect(page.locator(".search-results .search-group", { hasText: "Chat" })).toBeVisible();
  const threadRow = page.locator(".search-results .leaf-card", { hasText: marker }).first();
  await clickLeafMenuItem(threadRow, "Open");
  await expect(page.locator(".p-owner .turn-text", { hasText: marker })).toBeVisible();
});
