import { describe, it, expect } from "vitest";
import { placeMenu, type Rect } from "@tinytars/frame/anchored-menu.svelte";

const viewport = { width: 1000, height: 800 };
const panel = { width: 160, height: 120 };

function rect(partial: Partial<Rect>): Rect {
  return { top: 0, left: 0, right: 0, bottom: 0, ...partial };
}

describe("placeMenu", () => {
  it("places below the trigger when there's room", () => {
    const trigger = rect({ top: 100, bottom: 120, left: 300, right: 340 });
    const p = placeMenu(trigger, panel, viewport);
    expect(p.top).toBe(124); // bottom + GAP(4)
    expect(p.maxHeight).toBeUndefined();
  });

  it("flips above when below doesn't fit but above does (composer stuck at viewport bottom)", () => {
    const trigger = rect({ top: 750, bottom: 770, left: 300, right: 340 });
    const p = placeMenu(trigger, panel, viewport);
    expect(p.top).toBe(750 - 4 - 120); // top - GAP - panelHeight
    expect(p.maxHeight).toBeUndefined();
    expect(p.top + panel.height).toBeLessThanOrEqual(viewport.height);
  });

  it("clamps with max-height when neither side fully fits, picking the side with more room", () => {
    // trigger near the top: spaceAbove is tiny, spaceBelow is huge relative to a giant panel
    const trigger = rect({ top: 10, bottom: 30, left: 300, right: 340 });
    const giantPanel = { width: 160, height: 2000 };
    const p = placeMenu(trigger, giantPanel, viewport);
    expect(p.top).toBe(34); // below, since spaceBelow > spaceAbove
    expect(p.maxHeight).toBeDefined();
    expect(p.maxHeight!).toBeGreaterThan(0);
  });

  it("clamps horizontally into the viewport on the right edge", () => {
    const trigger = rect({ top: 100, bottom: 120, left: 950, right: 995 });
    const p = placeMenu(trigger, panel, viewport);
    expect(p.left).toBeLessThanOrEqual(viewport.width - panel.width - 8);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });

  it("clamps horizontally into the viewport on the left edge", () => {
    const trigger = rect({ top: 100, bottom: 120, left: 0, right: 20 });
    const p = placeMenu(trigger, panel, viewport);
    expect(p.left).toBe(8); // right-align would put it off-screen left, so clamp to margin
  });

  it("never lets the panel's bottom edge exceed the viewport when placed below", () => {
    const trigger = rect({ top: 500, bottom: 520, left: 300, right: 340 });
    const p = placeMenu(trigger, panel, viewport);
    const bottom = p.top + (p.maxHeight ?? panel.height);
    expect(bottom).toBeLessThanOrEqual(viewport.height);
  });

  // The test above passes without the clamp — its trigger fits below, so it never reaches the branch
  // that could escape. This is the case that actually exercises it: a short viewport where the panel
  // fits NEITHER side and there is more room below, so the 80px max-height floor beats the space
  // available. Before the clamp this returned top 124 + height 80 = 204 against a 200px viewport.
  it("keeps the panel on-screen when it fits neither side and the max-height floor exceeds the gap", () => {
    const short = { width: 1000, height: 200 };
    const tall = { width: 160, height: 150 };
    const trigger = rect({ top: 60, bottom: 120, left: 300, right: 340 });
    const p = placeMenu(trigger, tall, short);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + (p.maxHeight ?? tall.height)).toBeLessThanOrEqual(short.height);
  });

  // The other half of the vertical clamp, and it needs its own case because the one above passes with
  // a one-sided `Math.min`. Flipping above can land the panel exactly at 0 when it *just* fits, which
  // is on-screen but flush to the edge — the horizontal clamp already refuses that, so this keeps the
  // two axes honest with each other.
  it("respects the top margin when a flipped-above panel would sit flush at 0", () => {
    const short = { width: 1000, height: 180 };
    const tall = { width: 160, height: 100 };
    const trigger = rect({ top: 104, bottom: 124, left: 300, right: 340 });
    const p = placeMenu(trigger, tall, short);
    expect(p.top).toBe(8);
  });
});
