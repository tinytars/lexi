// Can the person in front of this screen get to Account settings?
//
// On 2026-10-18 an individual account reported that it could not. Signed in, vault open, no record
// created yet — and that screen is Onboarding, which rendered Continue, Skip and Sign out and
// nothing else. The Account panel is the only route to Google or a passkey, so an account whose one
// credential was a password had no way in the product to add a second one, which is the lockout the
// passkey and recovery work existed to remove. The LoginScreen's own sign-up copy promises those
// methods are "removable any time in Account settings" — a screen that branch could not open.
//
// Pinned the way a11y-static.test.ts argues for: DERIVED from the other side of the invariant.
// App.svelte's top-level chain is read as a chain, and every branch that is not the signed-OUT
// screen has to offer the account route. A seventh screen added without one fails this without the
// test having heard of it; a list of today's six branches would have caught only their deletion.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * The column-zero `{#if}` … `{/if}` block that chooses which whole screen is shown. Found by what
 * it contains — the signed-out screen — rather than by its line number or its condition, both of
 * which move. Branch bodies come back in source order.
 */
function screenChain(src: string): string[] {
  const lines = src.split("\n");
  const blocks: string[][] = [];
  let open: number | null = null;
  lines.forEach((line, i) => {
    if (line.startsWith("{#if ")) open = i;
    else if (line.startsWith("{/if}") && open !== null) {
      blocks.push(lines.slice(open, i));
      open = null;
    }
  });
  const chain = blocks.find((b) => b.some((l) => l.includes("<LoginScreen")));
  if (!chain) throw new Error("no top-level screen chain found in App.svelte");
  const branches: string[][] = [];
  for (const line of chain) {
    if (line.startsWith("{#if ") || line.startsWith("{:else")) branches.push([]);
    branches[branches.length - 1]?.push(line);
  }
  return branches.map((b) => b.join("\n"));
}

// Three shapes count, and all three end at account.openPanel(): an AccountMenu wired directly in
// the branch, the hoisted individualAccountMenu snippet, or the sidebar, which renders its own
// accountArea.
const OFFERS_ACCOUNT = /onAccount=|individualAccountMenu|appSidebar/;

describe("every signed-in screen offers a route to Account settings", () => {
  const branches = screenChain(read("src/App.svelte"));

  it("reads the chain rather than a hard-coded list", () => {
    expect(branches.length).toBeGreaterThanOrEqual(6);
  });

  it.each(branches.map((b, i) => [i, b] as const))("branch %i", (_i, body) => {
    // The signed-out screen is the one place with no account to open.
    if (body.includes("<LoginScreen")) return;
    expect(body).toMatch(OFFERS_ACCOUNT);
  });
});

describe("every Onboarding call site hands it an account area", () => {
  // The prop is optional in @tinytars/frame, because the package cannot know whether its host has
  // an account at all. This app does, on every screen, so an Onboarding rendered here without one
  // is the 2026-10-18 defect returning.
  const files = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".svelte"))
    .concat(readdirSync(join(ROOT, "src/lib")).filter((f) => f.endsWith(".svelte")).map((f) => `lib/${f}`));

  it("finds the call site and it passes accountArea", () => {
    const sites = files.flatMap((f) => {
      const src = read(join("src", f));
      return [...src.matchAll(/<Onboarding\b[\s\S]*?\/>/g)].map((m) => ({ file: f, tag: m[0] }));
    });
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const { file, tag } of sites) expect(tag, file).toMatch(/accountArea=/);
  });
});
