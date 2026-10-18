// @vitest-environment jsdom
import { it, expect, afterEach } from "vitest";
import { createRawSnippet, flushSync } from "svelte";
import { render } from "../support/mount";
import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
import { configureRetell } from "@tinytars/frame/retell-registry.svelte";

const body = createRawSnippet(() => ({ render: () => "<p>LDL was 142 mg/dL on 2026-07-21.</p>" }));
const asked: string[] = [];
const cody = { label: "Cody's take", voice: "cody", retell: async (text: string) => (asked.push(text), "Your LDL hit 142 mg/dL on 2026-07-21.") };

afterEach(() => {
  configureRetell(null);
  asked.length = 0;
});

// The panel is portaled to <body>, so its items are looked up document-wide.
function menuItem(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  el.querySelector<HTMLButtonElement>(".leaf-menu-trigger")?.click();
  flushSync();
  return [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.trim() === label);
}

async function settle() {
  await new Promise((r) => setTimeout(r));
  flushSync();
}

it("retells the shown text in place, relabels it, and restores the original", async () => {
  configureRetell(cody);
  const el = render(PersonaBubble, { persona: "assistant" as const, label: "Lexi", children: body });

  menuItem(el, "Cody's take")!.click();
  await settle();
  expect(asked).toEqual(["LDL was 142 mg/dL on 2026-07-21."]);
  expect(el.querySelector(".persona-body")!.textContent).toBe("Your LDL hit 142 mg/dL on 2026-07-21.");
  expect(el.querySelector(".persona-tag")!.textContent).toBe("Cody's take");

  menuItem(el, "Show original")!.click();
  flushSync();
  expect(el.querySelector(".persona-body")!.textContent).toBe("LDL was 142 mg/dL on 2026-07-21.");
  expect(el.querySelector(".persona-tag")!.textContent).toBe("Lexi");
});

it("keeps the original when the retelling fails", async () => {
  configureRetell({ ...cody, retell: async () => null });
  const el = render(PersonaBubble, { persona: "assistant" as const, label: "Lexi", children: body });

  menuItem(el, "Cody's take")!.click();
  await settle();
  expect(el.querySelector(".persona-body")!.textContent).toBe("LDL was 142 mg/dL on 2026-07-21.");
  expect(el.querySelector(".persona-tag")!.textContent).toBe("Lexi");
});

it("offers no retelling on a bubble that opts out, or on a non-assistant bubble", () => {
  configureRetell(cody);
  const optedOut = render(PersonaBubble, { persona: "assistant" as const, label: "Cody", retellable: false, children: body });
  const owner = render(PersonaBubble, { persona: "owner" as const, label: "You", children: body });
  expect(optedOut.querySelector(".leaf-menu-trigger")).toBeNull();
  expect(owner.querySelector(".leaf-menu-trigger")).toBeNull();
});

it("drops a shown retelling once the app stops offering it", async () => {
  configureRetell(cody);
  const el = render(PersonaBubble, { persona: "assistant" as const, label: "Lexi", children: body });
  menuItem(el, "Cody's take")!.click();
  await settle();

  configureRetell(null);
  flushSync();
  expect(el.querySelector(".persona-body")!.textContent).toBe("LDL was 142 mg/dL on 2026-07-21.");
  expect(el.querySelector(".persona-tag")!.textContent).toBe("Lexi");
});
