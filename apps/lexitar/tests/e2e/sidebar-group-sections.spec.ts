import { test, expect } from "./_fixtures";
import { openSyntheticAsProvider, openSynthetic } from "./_synthetic";
import { clickNav } from "./_nav";
import { openAllRow } from "./_sidebar-group";

// Split out of sidebar-group-expand.spec.ts (W76): a hosted 2-vCPU/7-GB runner kills workerd
// partway through a long spec, and `--shard` partitions by FILE, so one oversized file sets the
// floor for every slice.
// This half: each section's own row shape — what All spans, and what has no Uncategorized.

test("Reports has no Uncategorized row; untagged reports live under All", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Reports");
  const labels = await page.locator(".sidebar .group-list .sub-item").allInnerTexts();
  // innerText collapses the space before the count, so this reads "All(9)".
  expect(labels.some((l) => /^All\s*\(/.test(l.trim()))).toBe(true);
  expect(labels.some((l) => /Uncategorized/i.test(l))).toBe(false);
});

test("Chat's All row is clickable and marks itself active, exactly like every other section's", async ({ page }) => {
  // Chat's All row was rendered with activeKey={null} and a no-op onSelect, so it alone never took
  // the active state clicking a group row gives everywhere else. Same props as every other section
  // now — activeGroup + onSelectGroup.
  await openSynthetic(page);

  async function clickAllAndExpectActive() {
    const all = page.locator(".sidebar .group-list .side-row").first().locator(".sub-item");
    await expect(all).toContainText("All");
    await all.click();
    await expect(all).toHaveClass(/active/);
  }

  await clickNav(page, "Notes");
  await clickAllAndExpectActive();
  await clickNav(page, "Chat");
  await clickAllAndExpectActive();
});

test("Exploration renders one leaf cell per item, and All spans every system", async ({ page }) => {
  // Exploration used to be one AI bubble per (system, modality) with items as bare <li>s — the only
  // section whose listed items were not leaves. Each item is its own LeafCard now, matching Study's
  // shape with the patient half absent.
  await openSyntheticAsProvider(page);
  await clickNav(page, "Exploration");

  const cards = page.locator(".tests-consider .leaf-card");
  await expect(cards.first()).toBeVisible();
  // Each card is one item, rendered as a turn tuple: the LexiTar half plus an explicit empty state
  // for the patient half that never happened — the same shape Study and Treatment use.
  await expect(cards.first().locator(".persona-bubble.p-assistant")).toHaveCount(1);
  await expect(cards.first().locator(".leaf-row-empty")).toContainText("Not asked");
  // The claim is "no bare <li>s anymore", so assert it against list items — which do exist — rather
  // than against `.tc-items`, a class the retirement deleted and nothing can bring back.
  await expect(page.locator(".tests-consider li")).toHaveCount(0);

  const rows = await openAllRow(page);
  const itemCount = await rows.count();
  // All spans every system, so it lists at least as many items as the currently rendered system.
  expect(itemCount).toBeGreaterThan(0);
  const allCount = await page.locator(".sidebar .group-list .side-row").first().locator(".sub-item").textContent();
  expect(allCount).toContain(`(${itemCount})`);

  // Selecting All renders every system's cells, not just the first system's.
  await page.locator(".sidebar .group-list .side-row").first().locator(".sub-item").click();
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBe(itemCount);
});

test("Analysis lists its LexiTar turns as cells, with an All row over every block", async ({ page }) => {
  // Analysis was a static six-row nav table over blocks that rendered bare AI bubbles. Each block's
  // turns are leaf cells now, and the sidebar lists the items, not just the block headings.
  await openSyntheticAsProvider(page);
  await clickNav(page, "Analysis");

  const cards = page.locator(".analysis .leaf-card");
  await expect(cards.first()).toBeVisible();
  // Every card is a turn tuple: the LexiTar half, plus the patient half shown as an empty state
  // saying why it is absent rather than collapsing.
  await expect(cards.first().locator(".persona-bubble.p-assistant")).toHaveCount(1);
  await expect(cards.first().locator(".leaf-row-empty")).toContainText("Not asked");

  // All spans every block, so its count is the sum of the block rows'.
  const groupLabels = await page.locator(".sidebar .group-list .sub-item").allInnerTexts();
  const counts = groupLabels.map((l) => Number(/\((\d+)\)/.exec(l)?.[1] ?? 0));
  expect(groupLabels[0]).toContain("All");
  expect(counts[0]).toBe(counts.slice(1).reduce((a, b) => a + b, 0));
  expect(counts[0]).toBeGreaterThan(0);

  // And All lists exactly the cells the page renders.
  const rows = await openAllRow(page);
  expect(await rows.count()).toBe(await cards.count());
});

test("Recommended Markers lives under Notes, between Questions and Glossary, as turn cells", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Notes");

  // It is nested under Notes, in order — and no longer a flat top-level row.
  const groupLabels = (await page.locator(".sidebar .group-list .sub-item").allInnerTexts()).map((l) => l.trim());
  const rec = groupLabels.findIndex((l) => l.startsWith("Markers"));
  const glossary = groupLabels.findIndex((l) => l.startsWith("Glossary"));
  expect(rec).toBeGreaterThan(0);
  expect(glossary).toBeGreaterThan(rec);
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Markers" }).filter({ hasNotText: "Markers Wall" })).toHaveCount(1); // only the marker wall stays a top-level row

  // Clicking the group row switches the pane — the bug that made a nested child click a no-op.
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Markers" }).click();
  const cards = page.locator(".recommended-markers .leaf-card");
  await expect(cards.first()).toBeVisible();

  // One cell per body-system group, each a turn tuple with the patient half absent-but-shown.
  await expect(cards.first().locator(".persona-bubble.p-assistant")).toHaveCount(1);
  await expect(cards.first().locator(".leaf-row-empty")).toContainText("Not asked");
  // The sidebar lists exactly the cells the page renders. Read the row's OWN count badge rather
  // than counting `.group-children` rows: Notes' All row is expanded by default, so that selector
  // spans every expanded group, not this one.
  const label = (await page.locator(".sidebar .group-list .sub-item", { hasText: "Markers" }).textContent()) ?? "";
  expect(Number(/\((\d+)\)/.exec(label)?.[1])).toBe(await cards.count());
});
