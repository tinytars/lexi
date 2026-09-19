import { type Page, type Locator } from "@playwright/test";
import { ALL_SECTIONS } from "../../src/lib/report-sections";
import { modeForSection, type SidebarMode } from "../../src/lib/sidebar-mode";

const KEY_BY_LABEL = new Map<string, string>([["Search", "search"], ["Chat", "chat"], ...ALL_SECTIONS.map((s): [string, string] => [s.label, s.key])]);

function keyFor(label: string): string {
  const key = KEY_BY_LABEL.get(label);
  if (!key) throw new Error(`no sidebar row is labelled "${label}"`);
  return key;
}

export const navRow = (page: Page, label: string): Locator => page.getByTestId(`nav-${keyFor(label)}`);

export async function clickNav(page: Page, label: string) {
  const mode = modeForSection(keyFor(label));
  await page.getByTestId("nav-search").waitFor({ state: "attached" });
  if (mode) await setSidebarMode(page, mode);
  await navRow(page, label).click();
}

// Allergies/Family/Bio are reachable only through Profile's lower-zone group list.
export async function clickProfileSub(page: Page, label: "Bio" | "Allergies" | "Family") {
  await clickNav(page, "Profile");
  await page.locator(".sidebar .group-list .sub-item", { hasText: label }).click();
}

// No-op when the toggle isn't rendered (a patient session) or the mode is already selected.
export async function setSidebarMode(page: Page, mode: SidebarMode) {
  const button = page.getByTestId(`mode-${mode}`);
  if ((await button.count()) > 0 && (await button.getAttribute("aria-selected")) !== "true") await button.click();
}
