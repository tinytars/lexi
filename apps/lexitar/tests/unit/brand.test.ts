import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_DESCRIPTION } from "../../src/lib/brand";

// W40 Phase 1 — the LexiTar identity is adopted and the old "health dashboard" name is gone.
describe("brand / product naming (W40)", () => {
  it("exposes the locked LexiTar strings", () => {
    expect(PRODUCT_NAME).toBe("LexiTar");
    expect(PRODUCT_TITLE).toBe("LexiTar — Health Literacy Utility");
  });

  it("index.html carries the LexiTar title + a description, and stays noindex", () => {
    const html = readFileSync(resolve("index.html"), "utf8");
    expect(html).toContain(`<title>${PRODUCT_TITLE}</title>`);
    expect(html).toContain(`content="${PRODUCT_DESCRIPTION}"`);
    expect(html).toMatch(/name="robots"\s+content="noindex,nofollow"/);
    expect(html).not.toMatch(/health dashboard/i);
  });

  it("no 'health dashboard' remnant in the app shell or entry HTML", () => {
    const app = readFileSync(resolve("src/App.svelte"), "utf8");
    expect(app).not.toMatch(/health dashboard/i);
    expect(app).toContain("PRODUCT_NAME");
  });
});
