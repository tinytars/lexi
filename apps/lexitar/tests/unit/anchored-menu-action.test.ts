/**
 * @vitest-environment jsdom
 */
// W76 — placeMenu's math already had tests; the ACTION around it had none, and every branch in it
// fires only near a screen edge or on a keyboard — the cases a mouse-driven e2e never reaches.
//
// Two of them are not cosmetic. The panel is reparented into <body>, so a Tab out of it lands the
// user in the page behind the menu, and a close with focus still inside drops focus to <body> — a
// keyboard user ends up at the top of the document after every menu action. The third is the
// orphaned-node bug the module's own comment records: Svelte cannot tear down a node it no longer
// contains, so the action must remove it, or two "Delete" items stay live in the accessibility tree.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { anchoredMenu } from "@tinytars/frame/anchored-menu.svelte";

let anchor: HTMLButtonElement;
let panel: HTMLElement;

// jsdom implements no ResizeObserver and a browser always has one, so this is a polyfill rather than
// a mock — made controllable so "layout settled late" can be driven deliberately instead of waited for.
const observers: ResizeObserverCallback[] = [];
// Registering on observe() rather than in the constructor is the whole point: a callback that fires
// for a panel nobody observed would let these tests pass with the observer unwired, which is the one
// failure a regression test for an unwired observer cannot afford.
class StubResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    observers.push(this.cb);
  }
  unobserve() {
    this.disconnect();
  }
  disconnect() {
    const i = observers.indexOf(this.cb);
    if (i >= 0) observers.splice(i, 1);
  }
}
globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
const settle = () => [...observers].forEach((cb) => cb([], {} as ResizeObserver));
/** The action schedules through rAF; these tests want the frame to land before they assert. */
const runFrames = () => vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => (cb(0), 1));

/** jsdom lays nothing out, so the geometry the action reads is stated rather than measured. */
function boxes(triggerBottom: number, panelHeight: number) {
  anchor.getBoundingClientRect = () =>
    ({ top: triggerBottom - 20, bottom: triggerBottom, left: 300, right: 340, width: 40, height: 20 }) as DOMRect;
  panel.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 160, height: panelHeight }) as DOMRect;
}

function menu(labels: { text: string; disabled?: boolean }[]) {
  const el = document.createElement("div");
  for (const l of labels) {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = l.text;
    if (l.disabled) b.setAttribute("disabled", "");
    el.appendChild(b);
  }
  return el;
}

const key = (k: string, over: Partial<KeyboardEventInit> = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...over });
/** `null` when focus is on <body> — which is the failure this file exists to catch, not a label. */
const labelOf = () => (document.activeElement === document.body || !document.activeElement ? null : document.activeElement.textContent);

beforeEach(() => {
  observers.length = 0;
  document.body.innerHTML = "";
  anchor = document.createElement("button");
  anchor.textContent = "trigger";
  document.body.appendChild(anchor);
  panel = menu([{ text: "Edit" }, { text: "Translate" }, { text: "Delete" }]);
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  boxes(120, 100);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("mount", () => {
  it("portals the panel to <body> in fixed space, so no ancestor can clip it", () => {
    const parent = document.createElement("div");
    parent.appendChild(panel);
    document.body.appendChild(parent);
    const a = anchoredMenu(panel, { anchor, open: true });
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.position).toBe("fixed");
    a.destroy();
  });

  it("places below the trigger and moves focus into the menu when mounted open", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    expect(panel.style.top).toBe("124px");
    expect(labelOf()).toBe("Edit");
    a.destroy();
  });

  it("computes no placement while closed", () => {
    const a = anchoredMenu(panel, { anchor, open: false });
    expect(panel.style.top).toBe("");
    expect(labelOf()).toBeNull();
    a.destroy();
  });

  it("clamps and scrolls rather than letting an edge escape, when neither side fits", () => {
    // Trigger low on the page: more room above than below, and the panel fits in neither.
    boxes(700, 1200);
    const a = anchoredMenu(panel, { anchor, open: true });
    expect(panel.style.top).toBe("8px");
    expect(panel.style.maxHeight).toBe("668px");
    expect(panel.style.overflowY).toBe("auto");
    a.destroy();
  });

  it("leaves no max-height or scroll behind when the panel fits", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    expect(panel.style.maxHeight).toBe("");
    expect(panel.style.overflowY).toBe("");
    a.destroy();
  });
});

describe("keyboard", () => {
  it("moves down and up through the items", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    panel.dispatchEvent(key("ArrowDown"));
    expect(labelOf()).toBe("Translate");
    panel.dispatchEvent(key("ArrowUp"));
    expect(labelOf()).toBe("Edit");
    a.destroy();
  });

  it("wraps at both ends rather than stopping", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    panel.dispatchEvent(key("ArrowUp"));
    expect(labelOf()).toBe("Delete");
    panel.dispatchEvent(key("ArrowDown"));
    expect(labelOf()).toBe("Edit");
    a.destroy();
  });

  it("jumps to the ends with Home and End", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    panel.dispatchEvent(key("End"));
    expect(labelOf()).toBe("Delete");
    panel.dispatchEvent(key("Home"));
    expect(labelOf()).toBe("Edit");
    a.destroy();
  });

  it("traps Tab inside the menu instead of dropping the user into the page behind it", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    const e = key("Tab");
    panel.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(labelOf()).toBe("Translate");
    const back = key("Tab", { shiftKey: true });
    panel.dispatchEvent(back);
    expect(labelOf()).toBe("Edit");
    a.destroy();
  });

  it("skips a disabled item, which cannot be actioned anyway", () => {
    panel = menu([{ text: "Edit" }, { text: "Translate", disabled: true }, { text: "Delete" }]);
    const a = anchoredMenu(panel, { anchor, open: true });
    panel.dispatchEvent(key("ArrowDown"));
    expect(labelOf()).toBe("Delete");
    a.destroy();
  });

  it("does nothing at all in a menu with no actionable item", () => {
    panel = menu([{ text: "Edit", disabled: true }]);
    const a = anchoredMenu(panel, { anchor, open: true });
    expect(labelOf()).toBeNull();
    expect(() => panel.dispatchEvent(key("ArrowDown"))).not.toThrow();
    a.destroy();
  });

  it("leaves keys it does not own to the page", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    const e = key("a");
    panel.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(labelOf()).toBe("Edit");
    a.destroy();
  });
});

describe("open and close", () => {
  it("places and focuses on the transition into open, not on every update", () => {
    const a = anchoredMenu(panel, { anchor, open: false });
    a.update({ anchor, open: true });
    expect(labelOf()).toBe("Edit");
    panel.dispatchEvent(key("End"));
    a.update({ anchor, open: true });
    // Still on Delete — a re-render must not yank focus back to the first item mid-menu.
    expect(labelOf()).toBe("Delete");
    a.destroy();
  });

  it("returns focus to the trigger on close", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    a.update({ anchor, open: false });
    expect(labelOf()).toBe("trigger");
    a.destroy();
  });

  it("does not steal focus on close when the user has already moved it elsewhere", () => {
    const other = document.createElement("button");
    other.textContent = "elsewhere";
    document.body.appendChild(other);
    const a = anchoredMenu(panel, { anchor, open: true });
    other.focus();
    a.update({ anchor, open: false });
    expect(labelOf()).toBe("elsewhere");
    a.destroy();
  });
});

describe("teardown", () => {
  it("removes the panel it appended, so nothing is orphaned in <body>", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    a.destroy();
    expect(document.body.contains(panel)).toBe(false);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  });

  it("restores focus before the node goes, rather than leaving it on <body>", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    a.destroy();
    expect(document.activeElement).toBe(anchor);
  });

  it("stops repositioning once destroyed", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const a = anchoredMenu(panel, { anchor, open: true });
    a.destroy();
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(raf).not.toHaveBeenCalled();
  });
});

describe("repositioning", () => {
  it("follows the trigger on scroll, coalescing a burst into one frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const a = anchoredMenu(panel, { anchor, open: true });
    boxes(300, 100);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(panel.style.top).toBe("304px");
    a.destroy();
  });

  // W82 — the placement used to be one-shot, so a measurement taken before layout settled stood for
  // the life of the menu. That is what made runs 33072678513 and 33430419142 fail the same way: the
  // last menu item was "visible, enabled and stable" AND "outside of the viewport", retried for the
  // full 30s timeout. The panel is not mispositioned by a race here — it is CORRECTLY positioned for
  // a height that was wrong, which is why it never recovered and why an M3 never reproduced it.
  it("declines to place on a zero measurement, rather than parking the panel at the bottom edge", () => {
    boxes(120, 0);
    const a = anchoredMenu(panel, { anchor, open: true });
    expect(panel.style.top).toBe("");
    a.destroy();
  });

  it("places as soon as the real height arrives", () => {
    runFrames();
    boxes(120, 0);
    const a = anchoredMenu(panel, { anchor, open: true });
    boxes(120, 100);
    settle();
    expect(panel.style.top).toBe("124px");
    a.destroy();
  });

  it("pulls a panel whose content would run past the fold back inside the viewport", () => {
    runFrames();
    // Trigger low on an 800px viewport, panel under-measured as 20px: it "fits below", so it is
    // placed at 704 — where its real 300px of content would run to 1004 and take the last item,
    // Sign out, with it. Nothing but a second measurement can discover that.
    boxes(700, 20);
    const a = anchoredMenu(panel, { anchor, open: true });
    expect(panel.style.top).toBe("704px");

    boxes(700, 300);
    settle();
    expect(parseFloat(panel.style.top) + 300).toBeLessThanOrEqual(800);
    a.destroy();
  });

  it("stops observing the panel once destroyed", () => {
    const a = anchoredMenu(panel, { anchor, open: true });
    a.destroy();
    const raf = runFrames();
    settle();
    expect(raf).not.toHaveBeenCalled();
  });

  it("ignores scroll while closed", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const a = anchoredMenu(panel, { anchor, open: false });
    window.dispatchEvent(new Event("scroll"));
    expect(raf).toHaveBeenCalled();
    expect(panel.style.top).toBe("");
    a.destroy();
  });
});
