import { test, expect } from "./_fixtures";
import { openSyntheticAsProvider, openSynthetic, reloadOntoPatient } from "./_synthetic";
import { clickNav } from "./_nav";
import { openAllRow } from "./_sidebar-group";
import { openLeafMenu, clickLeafMenuItem, firstUnpinned } from "./_leaf-menu";
import { interceptVaultSave } from "./_stubs";

// What a leaf row carries (pin star, row actions, rename); split from sidebar-group-expand so shards stay small.

test("Chat's All row is metrically identical to every other section's", async ({ page }) => {
  await openSynthetic(page);

  async function groupMetrics() {
    const label = page.locator(".sidebar .group-list .sub-item").first();
    await expect(label).toBeVisible();
    const row = await label.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, minHeight: s.minHeight, padding: s.padding, textAlign: s.textAlign };
    });
    const indent = await page
      .locator(".sidebar .group-children")
      .first()
      .evaluate((el) => getComputedStyle(el).paddingLeft);
    return { ...row, indent };
  }

  await clickNav(page, "Chat");
  const chat = await groupMetrics();
  await clickNav(page, "Notes");
  const notes = await groupMetrics();

  expect(chat).toEqual(notes);
  // Guard the values themselves, so "identical" can't be satisfied by both regressing together.
  expect(chat.minHeight).toBe("40px");
  expect(chat.textAlign).toBe("left");
  expect(chat.indent).toBe("24px");
});

test("a thread row carries the pin star and the shared row actions, like every other leaf row", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Chat");
  const row = page.locator(".sidebar .leaf-list .side-row").first();
  await expect(row).toBeVisible();

  // The name promises two things and the body used to check neither: that the ★ slot is there (it
  // is what "carries the pin star" means) and that the menu offers what a thread can actually do.
  // A ⋮ existing says nothing — every section that has one passes that.
  await expect(row.locator(".pin-slot")).toHaveCount(1);
  await expect(row.locator(".pin-star")).toHaveCount(1);

  // sidebar-row-capabilities.ts: chat is `{ pin: true, rename: true, delete: true }` — the only
  // section besides Study and Hypothesis with all three. Assert the whole row, not that one exists.
  await openLeafMenu(row);
  await expect(page.getByRole("menuitem", { name: /^(Pin|Unpin)$/ })).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(1);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(1);
});

// A row's menu never offers an action its section cannot perform: Markers pins but never renames or deletes.
test("a Markers row offers Pin, and only Pin", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Markers");
  const chevron = page.locator('.sidebar .group-list .chevron[aria-label^="Expand"]').first();
  await chevron.click();
  const row = page.locator(".sidebar .group-children .side-row").first();
  await expect(row.locator(".sub-item")).toBeVisible();
  await expect(row.locator(".leaf-menu-trigger")).toHaveCount(1);

  // openLeafMenu, not a bare click: the trigger is hover-revealed wherever the leaf has a Pin.
  await openLeafMenu(row);
  await expect(page.getByRole("menuitem", { name: /^(Pin|Unpin)$/ })).toHaveCount(1);
  // The half that matters: a derived or generated item is never renameable or deletable from a row.
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
});

test("Notes' sidebar rows carry the pin menu, and a pin shows its star and holds the pinned prefix", async ({ page }) => {
  // The reported gap: rows that CAN be pinned showed neither a ★ nor any menu, because the actions
  // were only wired for Chat. Every section with a vault record behind its rows has them now.
  await openSynthetic(page);
  await clickNav(page, "Notes");

  const rows = page.locator(".sidebar .group-children .leaf-list .side-row");
  await expect(rows.first()).toBeVisible();

  const target = firstUnpinned(rows);
  const label = (await target.locator(".sub-item").textContent())?.trim() ?? "";
  expect(label).not.toBe("");
  await clickLeafMenuItem(target, "Pin");

  const pinnedRow = page.locator(".sidebar .group-children .leaf-list .side-row", { hasText: label });
  await expect(pinnedRow.locator(".pin-star.visible")).toBeVisible();
  await expectPinnedPrefix(page);

  // It survives a reload — the pin is a vault write, not view state.
  await page.reload();
  await clickNav(page, "Notes");
  await expect(
    page.locator(".sidebar .group-children .leaf-list .side-row", { hasText: label }).locator(".pin-star.visible"),
  ).toBeVisible();
  await expectPinnedPrefix(page);
});

// Within each list, no unpinned row may appear before a pinned one.
async function expectPinnedPrefix(page: import("@playwright/test").Page) {
  const lists = await page.locator(".sidebar .group-children .leaf-list").evaluateAll((els) =>
    els.map((el) => [...el.querySelectorAll(".side-row")].map((r) => !!r.querySelector(".pin-star.visible"))),
  );
  expect(lists.length).toBeGreaterThan(0);
  // Every caller has just pinned a row, so no pinned row at all is a failure.
  expect(lists.some((pins) => pins.includes(true))).toBe(true);
  for (const pins of lists) {
    const unpinnedAt = pins.indexOf(false);
    if (unpinnedAt !== -1) expect(pins.slice(unpinnedAt)).not.toContain(true);
  }
}

test("Notes offers Pin but no Rename — free text has no title field to rename", async ({ page }) => {
  await openSynthetic(page);
  await clickNav(page, "Notes");
  const note = page.locator(".sidebar .group-children .leaf-list .side-row").first();
  await openLeafMenu(note);
  await expect(page.getByRole("menuitem", { name: /^(Pin|Unpin)$/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
});

// Study is Investigator-only, so this needs the provider session.
test("Study offers inline Rename from the sidebar row, and it persists", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Study");

  const rows = () => page.locator(".sidebar .group-children .leaf-list .side-row");
  const original = (await rows().first().locator(".sub-item").textContent())?.trim() ?? "";
  expect(original.length).toBeGreaterThan(0);
  const renamed = `Sleep quality e2e ${Date.now()}`;

  async function renameRowShowing(current: string, next: string) {
    // By text, not by position: the row this test owns is the one showing `current`.
    const target = rows().filter({ has: page.locator(".sub-item", { hasText: current }) }).first();
    await expect(target).toBeVisible();
    await clickLeafMenuItem(target, "Rename");
    const input = page.locator(".sidebar .leaf-list .rename-input");
    await expect(input).toBeVisible();
    await input.fill(next);
    await input.press("Enter");
    await expect(page.locator(".sidebar .group-children .leaf-list .sub-item", { hasText: next })).toBeVisible();
  }

  await renameRowShowing(original, renamed);

  // Load-bearing: discarding the vault PUT makes this fail, so it reads back what was saved.
  await reloadOntoPatient(page);
  await clickNav(page, "Study");
  await expect(page.locator(".sidebar .group-children .leaf-list .sub-item", { hasText: renamed })).toBeVisible();
});

// Waiting on the captured PUT proves the debounced save flushed before the reload.
test("Hypothesis has an All row spanning every system, and its patient ideas pin", async ({ page }) => {
  const wasCaptured = interceptVaultSave(page);
  // Hypothesis rows are keyed positionally, so a pin must still address the real record.
  await openSyntheticAsProvider(page);
  await clickNav(page, "Hypothesis");
  const rows = await openAllRow(page);

  // Only a PATIENT idea is a DecisionEntry; an AI-proposed one has no record, so it gets no menu.
  const total = await rows.count();
  const withMenus = await page.locator(".sidebar .group-children .leaf-menu-trigger").count();
  expect(withMenus).toBeGreaterThan(0);
  expect(withMenus).toBeLessThan(total);

  const target = firstUnpinned(rows.filter({ has: page.locator(".leaf-menu-trigger") }));
  const label = (await target.locator(".sub-item").textContent())?.trim() ?? "";
  expect(label).not.toBe("");
  await clickLeafMenuItem(target, "Pin");
  await expect(
    page.locator(".sidebar .group-children .leaf-list .side-row", { hasText: label }).first().locator(".pin-star.visible"),
  ).toBeVisible();

  // It survives a reload — which a pin addressed to a positional key never would.
  await expect.poll(wasCaptured, { timeout: 10_000 }).toBe(true);
  await reloadOntoPatient(page);
  await clickNav(page, "Hypothesis");
  await openAllRow(page);
  await expect(
    page.locator(".sidebar .group-children .leaf-list .side-row", { hasText: label }).first().locator(".pin-star.visible"),
  ).toBeVisible();
});
