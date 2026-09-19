import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSynthetic } from "./_synthetic";
import { stubChatHistory } from "./_stubs";
import { clickLeafMenuItem } from "./_leaf-menu";

// W84 — the persona picker persists to the account for real (D1), and a Cody chat turn shows Cody's
// retelling under his name with Lexi's original one menu click away. Only the model is stubbed.

const LEXI = "• Your LDL was 142 mg/dL on 2026-07-21.";
const CODY = "Your LDL came in at 142 mg/dL on 2026-07-21.";

const personaToggle = (page: Page) => page.locator(".sidebar .persona-toggle");

// The preference lives on this worker's shared synthetic account, so every other spec expects Lexi back.
test.afterEach(async ({ page }) => {
  await page.request.put("/api/account/persona", { data: { persona: "lexi" } });
});

test("the persona picked in the sidebar survives a reload, and Cody's chat turn keeps Lexi's original", async ({ page }) => {
  await stubChatHistory(page);
  await page.route("**/api/chat", (route) => route.fulfill({ json: { kind: "answer", answer: LEXI } }));
  await page.route("**/api/persona-adapt", (route) => route.fulfill({ json: { kind: "adapted", persona: "cody", text: CODY } }));
  await openSynthetic(page);

  await personaToggle(page).getByRole("button", { name: "Cody", exact: true }).click();
  await expect(personaToggle(page).getByRole("button", { name: "Cody", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await (await page.request.get("/api/account/persona")).json()).persona).toBe("cody");

  await page.reload();
  await page.waitForSelector(".chat-tab textarea", { timeout: 15_000 });
  await expect(personaToggle(page).getByRole("button", { name: "Cody", exact: true })).toHaveAttribute("aria-pressed", "true");
  const composer = page.locator(".chat-tab textarea");
  await expect(composer).toHaveAttribute("placeholder", /^Ask Cody…/);

  await composer.fill("how is my LDL?");
  await page.click(".chat-tab button.send");
  const answer = page.locator(".p-assistant:not(:has(.pending))").last();
  await expect(answer.locator(".persona-tag")).toHaveText("Cody");
  await expect(answer.locator(".turn-text")).toHaveText(CODY);

  await clickLeafMenuItem(page.locator(".chat-tab .leaf-card-head").last(), "Show Lexi's original");
  await expect(answer.locator(".persona-tag")).toHaveText("Lexi");
  await expect(answer.locator(".turn-text")).toHaveText(LEXI);
});
