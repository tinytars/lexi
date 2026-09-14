import { test, expect } from "./_fixtures";
import { openAsProvider, openPatient } from "./_login";
import { clickNav } from "./_nav";

// Split out of sidebar-group-expand.spec.ts (W76): a hosted 2-vCPU/7-GB runner kills workerd
// partway through a long spec, and `--shard` partitions by FILE, so one oversized file sets the
// floor for every slice.
// This half: selecting a group or a child FILTERS the body, and selecting again clears it.

test("selecting a submenu FILTERS the body to that group, in every section", async ({ page }) => {
  // The reported bug: some submenus scrolled instead of filtering. Analysis took no group at all
  // (all six blocks stayed on screen); Hypothesis and Exploration fell back to the first system
  // when the selected one was empty, so the click looked ignored or showed the wrong cells.
  await openAsProvider(page, "Pablo");

  // Analysis: picking one block shows only that block.
  await clickNav(page, "Analysis");
  const blocks = page.locator(".analysis .an-block");
  const allBlocks = await blocks.count();
  expect(allBlocks).toBeGreaterThan(1);
  await page.locator(".sidebar .group-list .sub-item", { hasText: "On Treatment" }).click();
  await expect(blocks).toHaveCount(1);
  // The block heading that used to carry this text was removed (it sat outside the leaf card, unlike
  // every other title in the app, and repeated the cell's own). The cell's title is the check now.
  await expect(blocks.locator(".leaf-card-head")).toContainText(/On Treatment/i);
  // …and All brings them all back.
  await page.locator(".sidebar .group-list .sub-item").first().click();
  await expect(blocks).toHaveCount(allBlocks);

  // Hypothesis: a system with no topics renders its own empty state, never another system's cells.
  await clickNav(page, "Hypothesis");
  const rows = page.locator(".sidebar .group-list .side-row");
  for (let i = 1; i < (await rows.count()); i++) {
    const label = (await rows.nth(i).locator(".sub-item").textContent())?.trim() ?? "";
    if (!label.replace(/\s/g, "").endsWith('(0)')) continue;
    await rows.nth(i).locator(".sub-item").click();
    await expect(page.locator(".future-treatment .leaf-empty")).toBeVisible();
    // Scoped to the topic cards (.htc-topic is HypothesisTopicCard's title): the patient's own
    // decision list also renders .leaf-card and is not system-filtered.
    await expect(page.locator(".future-treatment .htc-topic")).toHaveCount(0);
    return; // one zero-count system is enough to prove the fallback is gone
  }
});

// The reported bug: "The items inside Notes Markers do not work correctly, they scroll instead of
// filtering. See how Planned filters as an example. The same missing under Analysis." Both sections
// list their CELLS as child rows, so a child click has to narrow the page, not just scroll to it.
test("a child row under Notes > Markers filters to that one system", async ({ page }) => {
  await openPatient(page);
  await clickNav(page, "Notes");
  const collapseAll = page.getByRole("button", { name: /^Collapse All/ });
  if (await collapseAll.count()) await collapseAll.first().click();
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Markers" }).first().click();

  const cells = page.locator(".recommended-markers .leaf-card");
  const total = await cells.count();
  expect(total).toBeGreaterThan(1);

  const expand = page.getByRole("button", { name: "Expand Markers" });
  if (await expand.count()) await expand.click();
  const child = page.locator(".sidebar .group-children .side-row .sub-item").first();
  const label = (await child.innerText()).trim();
  await child.click();

  await expect(cells).toHaveCount(1);
  await expect(cells.first().locator(".leaf-card-head")).toHaveText(new RegExp(label, "i"));
});

test("a child row under Analysis filters to that one turn", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await clickNav(page, "Analysis");
  expect(await page.locator(".analysis .leaf-card").count()).toBeGreaterThan(1);

  const expand = page.getByRole("button", { name: /^Expand / }).first();
  if (await expand.count()) await expand.click();
  const child = page.locator(".sidebar .group-children .side-row .sub-item").first();
  const label = (await child.innerText()).trim();
  await child.click();

  // One block, one cell — the block that owns the turn, showing only that turn.
  await expect(page.locator(".analysis .an-block")).toHaveCount(1);
  await expect(page.locator(".analysis .leaf-card")).toHaveCount(1);
  await expect(page.locator(".analysis .leaf-card-head")).toHaveText(new RegExp(label, "i"));
});

// Picking the group back means "show the whole group" — otherwise a child click would be a one-way
// door with no way back to the full list.
test("selecting the group again clears the child filter", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await clickNav(page, "Analysis");
  const all = await page.locator(".analysis .leaf-card").count();

  const expand = page.getByRole("button", { name: /^Expand / }).first();
  if (await expand.count()) await expand.click();
  await page.locator(".sidebar .group-children .side-row .sub-item").first().click();
  await expect(page.locator(".analysis .leaf-card")).toHaveCount(1);

  await page.locator(".sidebar .group-list .sub-item", { hasText: "All" }).first().click();
  await expect(page.locator(".analysis .leaf-card")).toHaveCount(all);
});

// The reported bug: the patient's own Hypothesis ideas showed under EVERY body system, identically.
// `filteredDecisions` only sorted by pin — it never filtered, despite the name. A DecisionEntry has
// no system of its own, so the AI's grouping is what supplies one.
test("a Hypothesis idea appears under its own system and under All, not everywhere", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await clickNav(page, "Hypothesis");

  const rows = page.locator(".group-list .sub-item");
  const titlesNow = async () => {
    const out: string[] = [];
    for (const h of await page.locator(".leaf-card-head").all()) out.push((await h.innerText()).replace("🔗", "").trim());
    return out;
  };

  await rows.filter({ hasText: "All" }).first().click();
  const all = await titlesNow();
  // A patient idea renders with its intervention as the title (not upper-cased like an AI topic).
  const idea = all.find((t) => /Pregnenolone/i.test(t));
  expect(idea, "expected a patient idea under All").toBeTruthy();

  // It must appear under exactly one body system, not all of them.
  let seenIn = 0;
  const n = await rows.count();
  for (let i = 1; i < n; i++) {
    await rows.nth(i).click();
    if ((await titlesNow()).some((t) => /Pregnenolone/i.test(t))) seenIn++;
  }
  expect(seenIn).toBe(1);
});
