import { describe, it, expect } from "vitest";
import { menuRegistry } from "@tinytars/frame/menu-registry.svelte";

// W68 — the canary for the vitest Svelte plugin. Without `plugins: [svelte()]` in vitest.config.ts,
// `$state` is undefined at import and every `.svelte.ts` module is reachable only through e2e, which
// cannot exercise a race. If the plugin is ever dropped, this file fails at import rather than
// silently not running — which is the failure mode that would let every rune test vanish while the
// suite stayed green.
describe("rune modules load under vitest", () => {
  it("module-level $state is live and shared", () => {
    expect(menuRegistry.isOpen("a")).toBe(false);
    menuRegistry.open("a");
    expect(menuRegistry.isOpen("a")).toBe(true);

    // The whole point of the singleton: opening another closes the first, with no coordination
    // between the two call sites.
    menuRegistry.open("b");
    expect(menuRegistry.isOpen("a")).toBe(false);
    expect(menuRegistry.isOpen("b")).toBe(true);

    menuRegistry.close("b");
    expect(menuRegistry.isOpen("b")).toBe(false);
  });
});
