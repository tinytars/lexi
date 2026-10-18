// A snippet prop a component declares and never renders.
//
// Onboarding.svelte was the opposite case — the app had a menu and the screen had nowhere to put it
// — and the fix adds a snippet prop, which fails in this second way instead: declared, typed,
// passed by the caller, and dropped on the floor with nothing to show for it. svelte-check cannot
// see it (an unused prop is legal) and the caller cannot see it either, because passing a snippet
// that is never rendered looks exactly like passing one that is.
//
// Derived from the declaration rather than from a list of names: a NEW snippet prop is swept by
// this the day it is added, which is what naming today's seven could not do.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const components = readdirSync(HERE).filter((f) => f.endsWith(".svelte"));

// `name?: Snippet` / `name: Snippet<[T]>` inside the $props() type literal.
const declared = (src: string): string[] =>
  [...src.matchAll(/^\s*(\w+)\??\s*:\s*Snippet\b/gm)].map((m) => m[1]);

describe("every snippet prop a component declares is rendered by it", () => {
  it("sweeps the whole package", () => {
    const dead: string[] = [];
    let checked = 0;
    for (const file of components) {
      const src = readFileSync(join(HERE, file), "utf8");
      for (const name of declared(src)) {
        checked++;
        // Rendered here, or handed to a child component as a prop — both are uses.
        const used = new RegExp(`@render\\s+${name}[\\s?(]|\\b${name}=\\{`).test(src);
        if (!used) dead.push(`${file}: ${name}`);
      }
    }
    expect(dead).toEqual([]);
    // The sweep is only worth anything if it found the declarations; a regex that matched nothing
    // would pass silently.
    expect(checked).toBeGreaterThanOrEqual(7);
  });
});
