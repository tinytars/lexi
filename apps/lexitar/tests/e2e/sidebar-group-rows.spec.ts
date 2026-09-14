import { test, expect } from "./_fixtures";
import { openAsProvider, openPatient } from "./_login";
import { clickNav } from "./_nav";
import { openAllRow } from "./_sidebar-group";
import { openLeafMenu } from "./_leaf-menu";
import { interceptVaultSave } from "./_stubs";

// Split out of sidebar-group-expand.spec.ts (W76): a hosted 2-vCPU/7-GB runner kills workerd
// partway through a long spec, and `--shard` partitions by FILE, so one oversized file sets the
// floor for every slice.
// This half: what a leaf row carries — the pin star, the shared row actions, inline rename.

test("Chat's All row is metrically identical to every other section's", async ({ page }) => {
  await openPatient(page);

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
  await openPatient(page);
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

// W62 REPLACES the assertion this test used to make. It read "Markers has no per-item record yet,
// so its rows get no kebab" — true only until Markers HAD a record. It does now: a marker row's pin
// is watchlist membership, the bit the app has always had, finally reachable from the sidebar. What
// still must hold is the narrower rule the old test was really protecting: a menu never offers an
// action the section cannot perform. Markers pins and does NOT rename or delete.
test("a Markers row offers Pin, and only Pin", async ({ page }) => {
  await openPatient(page);
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
  await openPatient(page);
  await clickNav(page, "Notes");

  const rows = page.locator(".sidebar .group-children .leaf-list .side-row");
  await expect(rows.first()).toBeVisible();

  // Pick a row that is NOT already pinned — this fixture ships with pinned notes.
  const count = await rows.count();
  let idx = -1;
  for (let i = 0; i < count; i++) {
    if ((await rows.nth(i).locator(".pin-star.visible").count()) === 0) { idx = i; break; }
  }
  expect(idx).toBeGreaterThanOrEqual(0);
  const target = rows.nth(idx);
  const label = (await target.locator(".sub-item").textContent())?.trim() ?? "";

  // The ⋮ replaces the ★ only on hover (LeafActionMenu's fine-pointer rule), so hover first.
  await target.locator(".pin-slot").hover();
  await target.locator(".leaf-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Pin" }).click();

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

// The ordering invariant: within each list, no unpinned row may appear before a pinned one.
//
// W65 — this used to guard the whole thing behind `if (lastPinned !== -1 && firstUnpinned !== -1)`,
// so it asserted NOTHING whenever every row was pinned or none was — including the case where the
// pin under test had silently failed to land, which is the one thing its callers rely on it to
// catch. It also flattened every expanded group into one array, where the invariant is per-list and
// a second group's pinned row legitimately follows the first group's unpinned ones.
async function expectPinnedPrefix(page: import("@playwright/test").Page) {
  const lists = await page.locator(".sidebar .group-children .leaf-list").evaluateAll((els) =>
    els.map((el) => [...el.querySelectorAll(".side-row")].map((r) => !!r.querySelector(".pin-star.visible"))),
  );
  expect(lists.length).toBeGreaterThan(0);
  // Every caller has just pinned a row, so a run with no pinned row anywhere is a failure, not a
  // vacuous pass.
  expect(lists.some((pins) => pins.includes(true))).toBe(true);
  for (const pins of lists) {
    const firstUnpinned = pins.indexOf(false);
    if (firstUnpinned !== -1) expect(pins.slice(firstUnpinned)).not.toContain(true);
  }
}

test("Notes offers Pin but no Rename — free text has no title field to rename", async ({ page }) => {
  await openPatient(page);
  await clickNav(page, "Notes");
  const note = page.locator(".sidebar .group-children .leaf-list .side-row").first();
  await note.locator(".pin-slot").hover();
  await note.locator(".leaf-menu-trigger").click();
  await expect(page.getByRole("menuitem", { name: /^(Pin|Unpin)$/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
});

// Study is Investigator-only, so this needs the provider session — a patient session has no mode
// toggle at all and clickNav would wait on one forever (the trap pin-persistence.spec.ts hit too).
// W64 — two problems, both about the restore. `renameFirstTo` re-resolved `.side-row` `.first()` on
// EACH call, so the restore ran after the first rename had re-rendered the list: if the renamed row
// were no longer first, it renamed a DIFFERENT study back to this one's title — and with
// playwright.config.ts's `workers: 1` against one shared vault, that corruption reaches every later
// spec. It now holds the row by the text it is currently showing.
//
// The name also claimed more than the body checked: there was no reload, so nothing about
// persistence was exercised. There is one now.
test("Study offers inline Rename from the sidebar row, and it persists", async ({ page }) => {
  await openAsProvider(page, "Pablo");
  await clickNav(page, "Study");

  const rows = () => page.locator(".sidebar .group-children .leaf-list .side-row");
  const original = (await rows().first().locator(".sub-item").textContent())?.trim() ?? "";
  expect(original.length).toBeGreaterThan(0);
  const renamed = `Sleep quality e2e ${Date.now()}`;

  async function renameRowShowing(current: string, next: string) {
    // By text, not by position: the row this test owns is the one showing `current`.
    const target = rows().filter({ has: page.locator(".sub-item", { hasText: current }) }).first();
    await expect(target).toBeVisible();
    await target.locator(".pin-slot").hover({ force: true });
    await target.locator(".leaf-menu-trigger").click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const input = page.locator(".sidebar .leaf-list .rename-input");
    await expect(input).toBeVisible();
    await input.fill(next);
    await input.press("Enter");
    await expect(page.locator(".sidebar .group-children .leaf-list .sub-item", { hasText: next })).toBeVisible();
  }

  try {
    await renameRowShowing(original, renamed);

    // "and it persists" — reload and confirm the new label came back from the vault, not just the
    // DOM. Verified load-bearing by stubbing the vault PUT to discard the write: this line then
    // fails, so it is really reading back what was saved.
    await page.reload();
    await page.waitForSelector(".roster-list");
    await page.click('.roster-name:has-text("Pablo")');
    await clickNav(page, "Study");
    await expect(page.locator(".sidebar .group-children .leaf-list .sub-item", { hasText: renamed })).toBeVisible();
  } finally {
    // W65 — the restore MUST run even when the body fails, and it did not: proving the persistence
    // assertion could fail (by discarding the write) meant the test threw at the reload check and
    // skipped the rename-back entirely. With `workers: 1` against one shared vault, a rename this
    // test made and did not undo is then the first Study row every later spec sees.
    await restoreTo(renamed, original);
  }

  /** Rename `from` back to `to`, tolerating a body that failed before the rename ever landed. */
  async function restoreTo(from: string, to: string) {
    const stale = rows().filter({ has: page.locator(".sub-item", { hasText: from }) });
    if ((await stale.count()) === 0) return; // the rename never took — nothing to put back
    await renameRowShowing(from, to);
    await expect(page.locator(".sidebar .group-children .leaf-list .sub-item", { hasText: to })).toBeVisible();
  }
});


// Same disk-safety shape as pin-persistence.spec.ts: capture the vault PUT and replay it on the
// next GET, so a reload sees the write without records/public/data-*.enc ever being touched. It
// also gives us the signal that the DEBOUNCED save actually flushed — reloading before it does is
// a race that looks exactly like "the pin did not persist".
test("Hypothesis has an All row spanning every system, and its patient ideas pin", async ({ page }) => {
  const wasCaptured = interceptVaultSave(page);
  // Two gaps the owner caught: Hypothesis had no All row at all, and its rows are keyed
  // positionally (topic+side+index, which is what the anchor needs) so a pin addressed an id
  // matching no record and silently did nothing.
  await openAsProvider(page, "Pablo");
  await clickNav(page, "Hypothesis");
  const rows = await openAllRow(page);

  // Only a PATIENT idea is a DecisionEntry; an AI-proposed one has no record, so it gets no menu.
  const total = await rows.count();
  const withMenus = await page.locator(".sidebar .group-children .leaf-menu-trigger").count();
  expect(withMenus).toBeGreaterThan(0);
  expect(withMenus).toBeLessThan(total);

  let idx = -1;
  for (let i = 0; i < total; i++) {
    if ((await rows.nth(i).locator(".leaf-menu-trigger").count()) > 0
      && (await rows.nth(i).locator(".pin-star.visible").count()) === 0) { idx = i; break; }
  }
  expect(idx).toBeGreaterThanOrEqual(0);
  const target = rows.nth(idx);
  const label = (await target.locator(".sub-item").textContent())?.trim() ?? "";

  await target.locator(".pin-slot").hover();
  await target.locator(".leaf-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(
    page.locator(".sidebar .group-children .leaf-list .side-row", { hasText: label }).first().locator(".pin-star.visible"),
  ).toBeVisible();

  // It survives a reload — which a pin addressed to a positional key never would.
  await expect.poll(wasCaptured, { timeout: 10_000 }).toBe(true);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".roster-list", { timeout: 15_000 });
  await page.locator(".roster-name", { hasText: "Pablo" }).click();
  await page.waitForSelector(".sidebar .nav-item", { timeout: 10_000 });
  await clickNav(page, "Hypothesis");
  await openAllRow(page);
  await expect(
    page.locator(".sidebar .group-children .leaf-list .side-row", { hasText: label }).first().locator(".pin-star.visible"),
  ).toBeVisible();
});
