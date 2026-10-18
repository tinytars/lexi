import { test, expect } from "./_fixtures";
import { openSyntheticAsProvider } from "./_synthetic";
import { clickNav } from "./_nav";

// Read-aloud outlives the bubble it started from, so the floating player must stay reachable after
// navigating away. That was the "plays non-stop with no way to stop it" bug. A stub engine that
// never finishes on its own stands in for the OS voice, so the state under test is whatever the
// controls set.
test("reading pauses, resumes, and stays stoppable from the player after its bubble unmounts", async ({ page }) => {
  await page.addInitScript(() => {
    class Utterance {
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    let current: Utterance | null = null;
    const engine = {
      speak(u: Utterance) { current = u; },
      cancel() { const u = current; current = null; if (u) setTimeout(() => u.onend?.(), 0); },
    };
    Object.defineProperty(window, "speechSynthesis", { value: engine, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance, configurable: true });
  });

  await openSyntheticAsProvider(page);
  await clickNav(page, "Analysis");
  const bubble = page.locator(".p-assistant").first();
  const player = page.getByRole("region", { name: "Read aloud" });

  await bubble.getByRole("button", { name: "Read aloud" }).click();
  await expect(player).toBeVisible();
  await expect(bubble.getByRole("button", { name: "Stop reading" })).toBeVisible();

  await bubble.getByRole("button", { name: "Pause reading" }).click();
  await expect(player.getByRole("button", { name: "Resume reading" })).toBeVisible();
  await player.getByRole("button", { name: "Resume reading" }).click();
  await expect(bubble.getByRole("button", { name: "Pause reading" })).toBeVisible();

  await clickNav(page, "Chat");
  await expect(bubble).toHaveCount(0);
  await expect(player).toBeVisible();
  await player.getByRole("button", { name: "Stop reading" }).click();
  await expect(player).toHaveCount(0);

  await clickNav(page, "Analysis");
  await expect(page.locator(".p-assistant").first().getByRole("button", { name: "Read aloud" })).toBeVisible();
});
