import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_DESCRIPTION, SAFETY_OWNER, SAFETY_RESPONSE } from "../../src/lib/brand";

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

// DPG 9B.4/9B.5 want a named owner and a stated response time. Three places say them — the report
// dialog, MODERATION.md and (in plover-code) the published policy — so they are one string here and
// this suite is what stops the document drifting away from what the user was told as they filed.
describe("brand / safety channel (DPG 9B.4, 9B.5)", () => {
  it("names an accountable role at the Foundation and commits to a measurable time", () => {
    expect(SAFETY_OWNER).toBe("the Tiny Tars Foundation's safety contact");
    expect(SAFETY_RESPONSE).toContain("3 business days");
    expect(SAFETY_RESPONSE).toContain("1 business day");
  });

  it("MODERATION.md quotes both verbatim rather than restating them", () => {
    const md = readFileSync(resolve("MODERATION.md"), "utf8").replace(/\n> /g, " ");
    expect(md).toContain(SAFETY_OWNER);
    expect(md).toContain(SAFETY_RESPONSE);
  });
});
