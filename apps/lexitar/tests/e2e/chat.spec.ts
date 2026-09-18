import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic } from "./_synthetic";
import { stubChatHistory, interceptChatHistory } from "./_stubs";

// W11b: Chat is the primary (default) tab — a Gemini-style thread shell. Multi-turn
// send/receive + the W7f error/billing recovery UI, with /api/chat network-stubbed
// via route interception — no live Anthropic, no secret.

async function openClient(page: Page) {
  // Isolate chat history per test: start thread-clean, never touch real R2/D1.
  await stubChatHistory(page);
  await openSynthetic(page);
  // Chat is the landing tab.
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });
}

function stubChat(page: Page, status: number, body: object) {
  return page.route("**/api/chat", (route) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

async function ask(page: Page, q: string) {
  await page.fill(".chat-tab textarea", q);
  await page.click(".chat-tab button.send");
}

test("chat renders the assistant answer on a 200", async ({ page }) => {
  await openClient(page);
  await stubChat(page, 200, { kind: "answer", answer: "Your gradient rose from 10 to 14." });
  await ask(page, "what changed since my last echo?");

  await expect(page.locator(".p-owner .turn-text")).toHaveText("what changed since my last echo?");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toHaveText("Your gradient rose from 10 to 14.");
  // W20 personas: the AI answer is the AI bubble, the question the Patient bubble.
  // M92 — the persona-tag now displays the product name (LexiTar), not the literal "AI".
  await expect(page.locator(".p-assistant .persona-tag")).toHaveText("LexiTar");
  await expect(page.locator(".p-owner .persona-tag")).toHaveText("Patient");
});

test("agentic: a tool_use round is executed in the browser, then the answer renders", async ({ page }) => {
  await openClient(page);
  const posts: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let n = 0;
  await page.route("**/api/chat", (route) => {
    posts.push(JSON.parse(route.request().postData() ?? "{}"));
    n += 1;
    const body =
      n === 1
        ? {
            kind: "tool_use",
            assistant: [{ type: "tool_use", id: "tu_1", name: "get_marker_readings", input: { markers: ["LDL-C"] } }],
            toolUses: [{ id: "tu_1", name: "get_marker_readings", input: { markers: ["LDL-C"] } }],
          }
        : { kind: "answer", answer: "Your LDL-C history is available." };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await ask(page, "show my LDL-C history");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toHaveText("Your LDL-C history is available.");

  // Two rounds: the initial ask, then the re-post after the browser ran the tool locally.
  expect(posts.length).toBe(2);
  const second = posts[1].messages;
  const toolResult = second.find(
    (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>)[0]?.type === "tool_result",
  );
  expect(toolResult).toBeTruthy();
  expect((toolResult!.content as Array<{ tool_use_id: string }>)[0].tool_use_id).toBe("tu_1");
  // The final thread holds only the user question + the final answer (no tool rounds) — one
  // paired leaf-card row, not a stray extra row for a tool-use round.
  await expect(page.locator(".chat-body .leaf-card")).toHaveCount(1);
});

test("persistence: a conversation is restored after reload, encrypted at rest (W16)", async ({ page }) => {
  // The built (non-DEV) app persists chat history over the network, not localStorage — capture the
  // PUT and replay it on GET (same shape as editor-roundtrip's vault save/reload), never touching R2.
  const captured = await interceptChatHistory(page);

  await openSynthetic(page);
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });
  await stubChat(page, 200, { kind: "answer", answer: "Your LDL-C is 98 mg/dL." });
  await ask(page, "what is my LDL-C?");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toHaveText("Your LDL-C is 98 mg/dL.");

  // Wait out the debounced save, then confirm the blob at rest is HD1 ciphertext — never plaintext PHI.
  await page.waitForTimeout(700);
  expect(captured()).toBeTruthy();
  expect(captured()!.subarray(0, 3).toString("latin1")).toBe("HD1");
  expect(captured()!.toString("latin1")).not.toContain("LDL");

  // Reload: W49 auto-resumes the session (no re-login), and the prior thread (question + answer) is
  // restored from the encrypted blob. The URL hash carries the thread, so a plain reload returns to it.
  await page.reload();
  await page.waitForSelector(".sidebar .nav-item", { timeout: 15_000 });
  await page.waitForSelector(".chat-tab textarea", { timeout: 10_000 });
  await expect(page.locator(".p-owner .turn-text")).toHaveText("what is my LDL-C?");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toHaveText("Your LDL-C is 98 mg/dL.");
});

test("a credit error shows the billing link and the account hint", async ({ page }) => {
  await openClient(page);
  await stubChat(page, 402, {
    error: "AI is temporarily unavailable: the account is out of credits.",
    errorCode: "insufficient_credit",
  });
  await ask(page, "summarize my labs");

  const err = page.locator(".chat-error");
  await expect(err).toContainText("out of credits");
  await expect(err.locator('a[href*="billing"]')).toBeVisible();
  await expect(err).toContainText("Log in as the organization account");
});

test("a busy error shows the retry message and no billing link", async ({ page }) => {
  await openClient(page);
  await stubChat(page, 503, { error: "The AI is busy right now — try again in a moment.", errorCode: "ai_busy" });
  await ask(page, "anything");

  const err = page.locator(".chat-error");
  await expect(err).toContainText("busy");
  await expect(err.locator("a")).toHaveCount(0);
});

test("a new thread starts a fresh conversation; the prior thread is listed", async ({ page }) => {
  await openClient(page);
  await stubChat(page, 200, { kind: "answer", answer: "first answer" });
  await ask(page, "first question about my echo");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toHaveText("first answer");

  // Start a new chat — the conversation clears; the prior thread appears in the list,
  // titled from its first message.
  // Scoped to the sidebar action button, not a bare title match — an untitled thread's own
  // sidebar row label defaults to the same "New chat" title text and would otherwise collide.
  await page.locator('.side-row-action[title="New chat"]').click();
  await expect(page.locator(".chat-body .leaf-card")).toHaveCount(0);
  await expect(page.locator(".sidebar .leaf-list")).toContainText("first question about my echo");
});

test.describe("phone viewport", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("a two-sided chat row's rg-grid stacks the AI reply below the patient turn (M90)", async ({ page }) => {
    await openClient(page);
    await stubChat(page, 200, { kind: "answer", answer: "Your gradient rose from 10 to 14." });
    await ask(page, "what changed since my last echo?");
    await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toHaveText("Your gradient rose from 10 to 14.");

    const grid = page.locator(".chat-body .leaf-card .rg-grid").first();
    const flexDirection = await grid.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(flexDirection).toBe("column");

    const patientBox = await grid.locator(":scope > *").first().boundingBox();
    const aiBox = await grid.locator(":scope > *").last().boundingBox();
    expect(patientBox).not.toBeNull();
    expect(aiBox).not.toBeNull();
    expect(aiBox!.y).toBeGreaterThanOrEqual(patientBox!.y + patientBox!.height);
  });
});

test("multi-turn: the second request carries the first turns as history in the messages array", async ({ page }) => {
  await openClient(page);

  const sent: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  await page.route("**/api/chat", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    sent.push({ messages: body.messages ?? [] });
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "answer", answer: `reply ${sent.length}` }) });
  });

  await ask(page, "first");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)")).toHaveText("reply 1");
  await ask(page, "second");
  await expect(page.locator(".p-assistant .turn-text:not(.pending)").nth(1)).toHaveText("reply 2");

  // First request: only the catalog+question turn.
  expect(sent[0].messages).toHaveLength(1);
  expect(sent[0].messages[0].content).toContain("first");
  // Second request: the prior user+assistant turns precede the new catalog+question turn (final Q+A only).
  expect(sent[1].messages).toHaveLength(3);
  expect(sent[1].messages[0]).toEqual({ role: "user", content: "first" });
  expect(sent[1].messages[1]).toEqual({ role: "assistant", content: "reply 1" });
  expect(sent[1].messages[2].content).toContain("second");
});
