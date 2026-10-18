// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "../support/mount";
import MarkersTab from "../../src/lib/MarkersTab.svelte";
import { syntheticVault, workerSeed } from "../fixtures/synthetic-patient";

const seed = workerSeed(0);
const vault = syntheticVault(seed);
const client = vault.clients[seed];

function markers(activeGroup: string | null, windowYears = Infinity) {
  const el = render(MarkersTab, { vault, client, clientId: seed, unitSystem: "imperial" as const, windowYears, activeGroup });
  const cards = [...el.querySelectorAll<HTMLElement>("section.client-section .leaf-card")];
  const emptyPlots = [...el.querySelectorAll("svg text")].filter((t) => t.textContent === "no data in window");
  return { el, cards, emptyPlots, stale: [...el.querySelectorAll(".mc-badge.stale")] };
}

function expectFlatStack(el: HTMLElement) {
  const stacks = el.querySelectorAll(".other-source > .stack");
  expect(stacks).toHaveLength(1);
  const cards = el.querySelectorAll(".other-source .leaf-card");
  expect(cards.length).toBeGreaterThan(0);
  expect(stacks[0].querySelectorAll(":scope > .leaf-card")).toHaveLength(cards.length);
}

describe("MarkersTab renders exactly the selected group", () => {
  it("with nothing selected, every marker in one flat block and no ratios", () => {
    const { el } = markers(null);
    expect(el.querySelectorAll(".marker-ratios-screen")).toHaveLength(0);
    expectFlatStack(el);
  });

  it("Ratios renders only the ratios screen", () => {
    const { el } = markers("ratios");
    expect(el.querySelectorAll(".marker-ratios-screen")).toHaveLength(1);
    expect(el.querySelectorAll(".other-source")).toHaveLength(0);
  });

  it("a system spanning lab and imaging stays one flat stack with no source split (M102)", () => {
    const { el, cards } = markers("level:Cardiovascular Risk");
    const text = cards.map((c) => c.textContent).join("\n");
    expect(text).toContain("Coronary Calcium Score");
    expect(text).toContain("Triglycerides");
    expectFlatStack(el);
  });
});

describe("the time window zooms charts instead of filtering markers (W65)", () => {
  it("hides no card, and badges exactly the cards left with nothing to plot", () => {
    const allTime = markers(null);
    expect(allTime.emptyPlots).toHaveLength(0);
    const total = allTime.cards.length;

    const { cards, emptyPlots, stale } = markers(null, 0.25);
    expect(cards).toHaveLength(total);
    expect(emptyPlots.length).toBeGreaterThan(0);
    expect(emptyPlots.length).toBeLessThan(total);
    expect(stale).toHaveLength(emptyPlots.length);
    expect(stale[0].textContent).toMatch(/^last \d{4}-\d{2}-\d{2}$/);
    const staleCard = cards.find((c) => c.contains(stale[0]))!;
    expect(staleCard.querySelector(".mc-delta")).toBeNull();
  });

  it("a longitudinal series shows its delta against the prior reading", () => {
    const delta = markers(null).el.querySelector(".mc-delta");
    expect(delta?.getAttribute("title")).toContain("vs prior");
  });
});
