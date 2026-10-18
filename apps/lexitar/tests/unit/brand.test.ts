import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PRODUCT_NAME, PRODUCT_TITLE, PRODUCT_DESCRIPTION, MODEL_DISCLOSURE, SAFETY_OWNER, SAFETY_RESPONSE } from "../../src/lib/brand";

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

// DPG 9A.6 — the disclosure is the control, so its substance is pinned here rather than left to
// whoever next edits a component: each clause below is a fact an assessor checks for, and losing one
// silently is the failure this suite exists to catch.
describe("brand / model disclosure (DPG 9A.6)", () => {
  it("states the recipient, the trigger, the residency and the absent agreement", () => {
    expect(MODEL_DISCLOSURE).toContain("the company that runs the language model");
    expect(MODEL_DISCLOSURE).toContain("whole documents, not");
    expect(MODEL_DISCLOSURE).toContain("when you open a record, not only when you ask a question");
    expect(MODEL_DISCLOSURE).toContain("about an hour");
    expect(MODEL_DISCLOSURE).toContain("no negotiated zero-retention arrangement");
  });

  it("does not offer the user a switch only the operator has", () => {
    expect(MODEL_DISCLOSURE).toContain("Whoever operates this deployment");
    expect(MODEL_DISCLOSURE).not.toMatch(/in Settings|you can turn/i);
  });

  // The provider is a deployment choice (`providerFor` in src/lib/model-config.ts), so naming one in
  // audited copy would make the string false wherever the operator picked another. Who it is today
  // belongs in the published policy, which is republished when it changes.
  it("names no vendor, and says where the current one is named instead", () => {
    expect(MODEL_DISCLOSURE).not.toMatch(/Anthropic|Azure|OpenAI|Google/);
    expect(MODEL_DISCLOSURE).toContain("privacy policy names the companies in use today");
  });

  it("is rendered both at the point of use and on demand", () => {
    expect(readFileSync(resolve("src/lib/Disclaimer.svelte"), "utf8")).toContain("MODEL_DISCLOSURE");
    expect(readFileSync(resolve("src/App.svelte"), "utf8")).toContain("MODEL_DISCLOSURE");
  });

  // Same fact in two documents drifts; this is the one that says which way it drifted.
  it("agrees with SECURITY.md about the model provider's terms", () => {
    const security = readFileSync(resolve("../../SECURITY.md"), "utf8");
    expect(security).toContain("zero-retention");
    expect(security).toContain("Azure AI Speech");
    expect(security).toMatch(/Anthropic/);
    expect(MODEL_DISCLOSURE).toContain("no negotiated zero-retention arrangement");
  });
});
