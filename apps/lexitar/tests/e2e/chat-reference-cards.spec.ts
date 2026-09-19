import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic, syntheticClientId, otherSyntheticIndex } from "./_synthetic";
import { clickNav } from "./_nav";
import { stubChatHistory, interceptChatHistory } from "./_stubs";
import { waitForChatReady } from "./_chat";

// M69 — a pasted permalink renders as a reference card; anchors are read from the live DOM, never hardcoded.

const myHash = () => `#${syntheticClientId(test.info().parallelIndex)}`;
const otherHash = () => `#${syntheticClientId(otherSyntheticIndex(test.info().parallelIndex))}`;

async function openClient(page: Page) {
  await stubChatHistory(page);
  await openSynthetic(page);
  await waitForChatReady(page);
}

async function ask(page: Page, q: string) {
  await page.fill(".chat-tab textarea", q);
  await page.click(".chat-tab button.send");
}

// Simulates a clean paste-of-only-a-link — dispatches a real ClipboardEvent so ChatTab's onpaste
// handler (which reads e.clipboardData) fires exactly as it would from an OS paste.
async function pasteLink(page: Page, text: string) {
  await page.locator(".chat-tab textarea").evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

async function goToChat(page: Page) {
  await clickNav(page, "Chat");
  await waitForChatReady(page);
}

async function openClientPersistent(page: Page) {
  await interceptChatHistory(page);
  await openSynthetic(page);
  await waitForChatReady(page);
}

test("pasting a marker and ratio permalink each render a reference card and navigate to the right element (consolidated anchor.ts)", async ({ page }) => {
  await openClient(page);

  await clickNav(page, "Markers");

  // M74 — the dedicated Watchlist section (and its chart-watch- anchors) is gone; watchAnchor
  // resolution now only serves pre-M74 permalinks already saved in a chat thread, covered by
  // reference-resolver.test.ts's "resolves a watchlist anchor from client.watchlist" unit test.
  //
  // M76 — Markers renders one sidebar-selected group at a time, so a plain marker figure and a
  // ratio figure never mount together; select each group in turn to grab its id. M96 Phase 2 —
  // Ungrouped (the default view) already has plain marker figures; Ratios needs an explicit click.
  const markerId = await page.locator('.leaf-card[id^="chart-"]:not([id^="chart-ratio-"]):not([id^="chart-watch-"])').first().getAttribute("id");
  await page.locator(".sidebar .group-list .sub-item", { hasText: "Ratios" }).click();
  const ratioId = await page.locator('.leaf-card[id^="chart-ratio-"]').first().getAttribute("id");
  expect(markerId).toBeTruthy();
  expect(ratioId).toBeTruthy();

  for (const [anchorId, tag] of [[markerId, "Marker"], [ratioId, "Ratio"]] as const) {
    await goToChat(page);
    await pasteLink(page, `${myHash()}/labs/markers/${anchorId}`);
    const card = page.locator(".reference-card").last();
    await expect(card).toBeVisible();
    await expect(card.locator(".reference-tag")).toHaveText(tag);
    // Direct DOM click — bypasses the chat body's auto-scroll-to-bottom effect racing Playwright's
    // pointer-actionability wait (the anchor itself, not the URL, is never persisted into the hash;
    // App.svelte's hash effect derives the hash from client+tab+section only, dropping anchor once
    // resolveAnchor's flash/scroll fires — so the target's presence is what proves navigation, not
    // the URL retaining the anchor segment).
    await card.evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Markers" })).toHaveClass(/active/);
    await expect(page).toHaveURL(new RegExp(`^http://localhost:8788/${myHash()}/markers`));
    await expect(page.locator(`[id="${anchorId}"]`)).toBeVisible();
  }
});

test("pasting a report permalink renders a reference card and navigates to it without deselecting the client", async ({ page }) => {
  await openClient(page);

  await clickNav(page, "Reports");
  const reportId = await page.locator('[id^="report-"]:not([id*="-dx-"])').first().getAttribute("id");
  expect(reportId).toBeTruthy();

  await goToChat(page);
  await pasteLink(page, `${myHash()}/labs/healthReports/${reportId}`);
  const card = page.locator(".reference-card").last();
  await expect(card).toBeVisible();
  await expect(card.locator(".reference-tag")).not.toHaveText("");

  await card.evaluate((el) => (el as HTMLElement).click());
  // The client stays selected while the click leaves Chat.
  await expect(page).toHaveURL(new RegExp(`^http://localhost:8788/${myHash()}/healthReports`));
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Reports" })).toHaveClass(/active/);
  await expect(page.locator(`[id="${reportId}"]`)).toBeVisible();
});

test("pasting a permalink for a different patient renders a non-clickable wrong-patient card with no data reaching the model", async ({ page }) => {
  await openClient(page);

  await pasteLink(page, `${otherHash()}/labs/markers`);
  const card = page.locator(".reference-card").last();
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/inert/);
  await expect(card.locator(".reference-note")).toContainText("different patient");
  // Inert card is a <div>, not a <button> — nothing to click through to navigate.
  expect(await card.evaluate((el) => el.tagName)).toBe("DIV");

  const before = page.url();
  await card.click({ force: true });
  await expect(page).toHaveURL(before);

  const posts: Array<{ messages: Array<{ content: string }> }> = [];
  await page.route("**/api/chat", (route) => {
    posts.push(JSON.parse(route.request().postData() ?? "{}"));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer: "ok" }) });
  });
  await ask(page, "anything to flag?");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)").last()).toHaveText("ok");
  const lastMsg = posts[0].messages[posts[0].messages.length - 1].content;
  const ctx = JSON.parse(lastMsg.replace(/^CONTEXT:\n/, "").split("\n\nQUESTION:")[0]);
  expect(ctx.references).toBeUndefined();
});

test("pasting a whole-tab and a section-level permalink render section cards that navigate correctly and add no CONTEXT.references entry", async ({ page }) => {
  // Persisted (capture-PUT/replay-GET) chat history — this test navigates away from Chat and back
  // to click the second card, and ChatTab fully unmounts/remounts across a tab switch, so its
  // pasted turns must survive the round trip via the real save/load path (chat.spec.ts's own
  // "persistence" test uses the same idiom).
  await openClientPersistent(page);

  // Labs, not e.g. Investigator — a patient's own patientVisibility policy can hide a tab
  // entirely, in which case App.svelte's visibility guard redirects away from it; Labs is always
  // visible to the patient themselves. A bare legacy tab id has no "no section" state anymore
  // (M82 Phase 5's LEGACY_TAB_DEFAULT resolves it to a real section — "labs" -> "markers" — since
  // the flat model has no section-less navigation target), so this exercises that back-compat path.
  await pasteLink(page, `${myHash()}/labs`);
  const wholeTabCard = page.locator(".reference-card").last();
  await expect(wholeTabCard).toBeVisible();
  await expect(wholeTabCard.locator(".reference-tag")).toHaveText("View");

  await pasteLink(page, `${myHash()}/doctor/treatment`);
  const sectionCard = page.locator(".reference-card").last();
  await expect(sectionCard).toBeVisible();
  await expect(sectionCard.locator(".reference-tag")).toHaveText("View");

  // Neither "section" kind folds any context — a follow-up send carries no references at all.
  const posts: Array<{ messages: Array<{ content: string }> }> = [];
  await page.route("**/api/chat", (route) => {
    posts.push(JSON.parse(route.request().postData() ?? "{}"));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer: "noted" }) });
  });
  await ask(page, "anything else?");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)").last()).toHaveText("noted");
  // Registered after the answer renders, so it catches the debounced persist that follows it.
  const persisted = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/api/chat-history/"));
  const lastMsg = posts[0].messages[posts[0].messages.length - 1].content;
  const ctx = JSON.parse(lastMsg.replace(/^CONTEXT:\n/, "").split("\n\nQUESTION:")[0]);
  expect(ctx.references).toBeUndefined();

  // Both reference-card turns must be persisted to survive the tab switch.
  await persisted;

  // Whole-tab card resolves via LEGACY_TAB_DEFAULT to Markers, client stays selected.
  await page.locator(".reference-card").first().evaluate((el) => (el as HTMLElement).click());
  await expect(page).toHaveURL(new RegExp(`^http://localhost:8788/${myHash()}/markers`));
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Markers" })).toHaveClass(/active/);

  // Section-level card (still in the same thread) navigates to Treatment.
  await goToChat(page);
  await page.locator(".reference-card").nth(1).evaluate((el) => (el as HTMLElement).click());
  await expect(page).toHaveURL(new RegExp(`^http://localhost:8788/${myHash()}/treatment`));
  await expect(page.locator(".sidebar .nav-list .nav-item", { hasText: "Treatment" })).toHaveClass(/active/);
});

test("a follow-up chat send after pasting a marker reference includes that marker's data in CONTEXT.references", async ({ page }) => {
  await openClient(page);

  await clickNav(page, "Markers");
  // M96 Phase 2 — Ungrouped is the default view and already renders plain (non-ratio) marker
  // figures flat; no group click needed.
  const markerId = await page.locator('.leaf-card[id^="chart-"]:not([id^="chart-ratio-"]):not([id^="chart-watch-"])').first().getAttribute("id");
  expect(markerId).toBeTruthy();

  await goToChat(page);
  await pasteLink(page, `${myHash()}/labs/markers/${markerId}`);
  await expect(page.locator(".reference-card").last()).toBeVisible();

  const posts: Array<{ messages: Array<{ content: string }> }> = [];
  await page.route("**/api/chat", (route) => {
    posts.push(JSON.parse(route.request().postData() ?? "{}"));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer: "got it" }) });
  });
  await ask(page, "what do you make of that marker?");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)").last()).toHaveText("got it");

  const lastMsg = posts[0].messages[posts[0].messages.length - 1].content;
  const ctx = JSON.parse(lastMsg.replace(/^CONTEXT:\n/, "").split("\n\nQUESTION:")[0]);
  expect(ctx.references).toHaveLength(1);
  expect(ctx.references[0].kind).toBe("marker");
  expect(ctx.references[0].data.marker).toBeTruthy();
  expect(ctx.references[0].data.rows).toBeTruthy();
});
