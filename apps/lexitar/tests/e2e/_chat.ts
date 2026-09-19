import { expect, type Page } from "@playwright/test";

// Hydration replaces the thread list, so a turn pasted before it lands is lost.
export async function waitForChatReady(page: Page) {
  await expect(page.getByTestId("chat-tab")).toHaveAttribute("data-hydrated", "true", { timeout: 10_000 });
}
