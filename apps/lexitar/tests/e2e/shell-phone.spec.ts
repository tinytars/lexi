import { test, expect } from "./_fixtures";
import { clickNav } from "./_nav";
import { stubChatHistory } from "./_stubs";
import { openSynthetic } from "./_synthetic";

// The responsive drawer at phone width — the sidebar starts closed, the hamburger opens it, and any
// navigation closes it again.
//
// Its own file because the viewport is set by a describe-level beforeEach: these cannot be
// interleaved with the desktop tests without carrying that state, which is the kind of coupling that
// made the original file indivisible in the first place.
//
// W74 — one of the seven files `shell-nav.spec.ts` became. It was 1437 lines and 53 tests, and
// `--shard` partitions by FILE: whichever shard held it ran ~56 tests against a single workerd while
// every other shard ran 19, which made it the gate's chronic red. Helpers shared by more than one of
// the seven live in `_shell.ts`; a helper with one caller stayed with its caller.

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  // M75 — the .tabbar/.sec-tabs two-bar model is retired; the sidebar is now an off-canvas
  // drawer on phone, closed by default and opened by the header's ☰ toggle. M82 Phase 3 — every
  // nav row (Sidebar.svelte's selectRow) now sets mobileOpen=false unconditionally, so the old
  // "a section with sub-sections keeps the drawer open" distinction no longer exists — tapping
  // any row navigates and closes the drawer.
  test("the sidebar starts closed; the hamburger opens it, and tapping a section navigates and closes the drawer", async ({ page }) => {
    await openSynthetic(page);
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
    await page.locator(".sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toHaveClass(/open/);
    await clickNav(page, "Treatment");
    await expect(page).toHaveURL(/#.*treatment/);
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });

  test("tapping a sub-section on phone navigates and closes the drawer", async ({ page }) => {
    await openSynthetic(page);
    await page.locator(".sidebar-toggle").click();
    await clickNav(page, "Treatment");
    await expect(page).toHaveURL(/#.*treatment/);
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });

  test("tapping Chat (no sub-sections) navigates and closes the drawer", async ({ page }) => {
    await openSynthetic(page);
    await page.locator(".sidebar-toggle").click();
    await clickNav(page, "Treatment"); // navigate away first; M82 — every row now closes the drawer
    await page.locator(".sidebar-toggle").click(); // reopen — Treatment's own navigation just closed it
    await clickNav(page, "Chat");
    await expect(page.locator(".chat-tab textarea")).toBeVisible();
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });

  test("tapping the scrim closes the drawer", async ({ page }) => {
    await openSynthetic(page);
    await page.locator(".sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toHaveClass(/open/);
    // W78 — click to the RIGHT of the 260px drawer, not the scrim's centre. The scrim spans the
    // full width beneath the open sidebar, so its centre (195, 475 at this viewport) sits over a
    // `.nav-item` at a higher z-index — measured, not guessed. Playwright's default centre click is
    // therefore always intercepted, and only landed at all while the 0.18s open transition still had
    // the drawer off-screen. That race is why this passed on an M3 and timed out on a hosted runner.
    await page.locator(".sidebar-scrim").click({ position: { x: 330, y: 200 } });
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  });

  test("the chat thread list is a drawer toggled from the header", async ({ page }) => {
    await openSynthetic(page);
    // M76 Phase 5 — Chat is the landing tab; the thread list now lives in the sidebar's own lower
    // zone, so it's part of the same drawer every other tab uses, closed until ☰ is tapped.
    await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
    await page.locator(".sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toHaveClass(/open/);
    await expect(page.locator(".sidebar .group-children .leaf-list")).toBeVisible();
    // M100 — the sidebar's nav-list alone can nearly fill the drawer's visible height on phone,
    // pushing the thread list below the fold; now that `.sidebar-scroll` actually clips/scrolls
    // (M100's fix — it previously didn't on mobile, the bug this milestone closes), reaching it
    // may require scrolling, same as any other overflowing drawer content.
    await page.locator(".sidebar .group-children .leaf-list").scrollIntoViewIfNeeded();
    await expect(page.locator(".sidebar .group-children .leaf-list")).toBeInViewport();
  });

  // M100 — regression for the bug that shipped M99 and earlier: `.sidebar-scroll` only got
  // `overflow-y: auto` inside the desktop `@media (min-width: 641px)` block, so on phone widths an
  // overflowing thread list was simply clipped with no way to scroll down and reach a thread below
  // the fold. Same isolation pattern as chat.spec.ts (stub chat-history so the thread count is
  // deterministic), then flood with enough new threads to force real overflow on 390x800.
  test("the drawer's thread list overflows the fold and stays reachable by scrolling (M100)", async ({ page }) => {
    await stubChatHistory(page);
    await page.route("**/api/chat", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer: "answer" }) }),
    );
    await openSynthetic(page);

    // Name the first thread distinctly, then push it down with enough freshly-created (and thus
    // more-recent, per sortThreads' lastActivityAt order) blank threads to overflow the drawer.
    await page.fill(".chat-tab textarea", "first question about my echo");
    await page.click(".chat-tab button.send");
    await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toBeVisible();

    await page.locator(".sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toHaveClass(/open/);
    for (let i = 0; i < 14; i++) {
      await page.locator('.side-row-action[title="New chat"]').click();
    }
    await expect(page.locator(".sidebar")).toHaveClass(/open/); // the "+" action never closes the drawer

    const scroller = page.locator(".sidebar .sidebar-scroll");
    const overflowing = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(overflowing).toBe(true);

    const target = page.locator(".sidebar .leaf-list .sub-item", { hasText: "first question about my echo" });
    await expect(target).not.toBeInViewport();
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
  });
});
