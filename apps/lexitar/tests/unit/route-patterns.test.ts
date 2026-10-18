import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patternsFor, renderModule } from "../../scripts/gen-route-patterns";

const APP = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

// Without this, adding a route reports as "(unmatched)" forever and nobody finds out.
describe("functions/_lib/route-patterns.ts", () => {
  it("is what the generator would write today — run `npm run gen:routes`", () => {
    const committed = readFileSync(join(APP, "functions/_lib/route-patterns.ts"), "utf8");
    expect(committed).toBe(renderModule(patternsFor(join(APP, "functions"))));
  });

  it("skips the middleware, which is a `_` file and not a route", () => {
    expect(patternsFor(join(APP, "functions"))).not.toContain("/api/_middleware");
  });
});
