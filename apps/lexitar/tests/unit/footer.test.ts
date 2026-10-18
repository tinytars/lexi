// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "../support/mount";
import OrgFooter from "@tinytars/frame/OrgFooter.svelte";
import { FOUNDATION } from "../../src/lib/brand";
import Disclaimer from "../../src/lib/Disclaimer.svelte";

describe("compliance chrome", () => {
  it("the footer carries the 501(c)(3) status, the EIN and every legal link", () => {
    const footer = render(OrgFooter, { org: FOUNDATION }).querySelector("footer.frame-footer")!;
    expect(footer.textContent).toContain("501(c)(3)");
    expect(footer.textContent).toContain("EIN: 39-2278196");
    const links = Object.fromEntries([...footer.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]));
    expect(links["Privacy Policy"]).toMatch(/tinytars\.foundation\/privacy$/);
    expect(links).toHaveProperty("Non-discrimination");
    expect(links).toHaveProperty("Terms of Service");
  });

  it("the disclaimer states the medical and privacy terms verbatim", () => {
    const text = render(Disclaimer, {}).querySelector("section.disclaimer")!.textContent;
    expect(text).toContain("does not provide medical advice, professional diagnostics, symptom triage, or treatment recommendations");
    expect(text).toContain("we never sell, rent, or monetize your personal or health data");
  });
});
