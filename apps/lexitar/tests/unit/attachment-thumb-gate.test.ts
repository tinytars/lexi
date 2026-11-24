// @vitest-environment jsdom
// A chip pays for its own bytes, and only once it is nearly on screen.
//
// `loading="lazy"` on the <img> never deferred anything here: the host fetches the object, decrypts
// it and mints a blob: URL before any element exists, so by the time the browser consults that
// attribute the whole cost is spent and only the decode is left. Nine call sites draw this strip
// inside an {#each} over rows, so opening a tab started every download it would ever need at once —
// measured at ~168 KB per 56-pixel chip against real stored originals.
//
// So the gate is an IntersectionObserver and the key is what it gates: resolveAttachmentUrl already
// treats a null key as nothing to do, which is why nothing else in the strip changes shape. These
// cases assert the fetch and not the render — `asked` records which keys the host was called for, so
// "nothing was downloaded" is an assertion rather than an inference from an empty box.
//
// jsdom computes no layout, so the observer is supplied per case rather than measured. The firing
// shim in tests/support/mount.ts is the default every other mounted suite sees; these cases replace
// it, which is the only way to express a chip that is below the fold.
import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { render } from "../support/mount";
import AttachmentThumb from "@tinytars/frame/AttachmentThumb.svelte";
import type { AttachmentUrl } from "@tinytars/frame/attachment-url.svelte";

const KEY = "1700000000-front.jpg";

const asked: string[] = [];
const serves: AttachmentUrl = async (_clientId, key) => (asked.push(key), "blob:thumb-bytes");

/** The stub resolves a microtask later, and the shim fires in one; a macrotask turn is past both. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r));
  flushSync();
}

const realObserver = globalThis.IntersectionObserver;
afterEach(() => {
  asked.length = 0;
  globalThis.IntersectionObserver = realObserver;
});

/** A chip below the fold: an observer that is created and observed and never reports anything. */
function neverFires() {
  const disconnects = vi.fn();
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {
      disconnects();
    }
  } as unknown as typeof IntersectionObserver;
  return disconnects;
}

/** One the case fires by hand, so "it scrolled into view" is an act and not a shim's default. */
function onDemand() {
  const callbacks: IntersectionObserverCallback[] = [];
  const disconnects = vi.fn();
  globalThis.IntersectionObserver = class {
    constructor(cb: IntersectionObserverCallback) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      disconnects();
    }
  } as unknown as typeof IntersectionObserver;
  return {
    disconnects,
    fire: () => {
      for (const cb of callbacks) cb([{ isIntersecting: true } as IntersectionObserverEntry], null as never);
    },
  };
}

const thumb = (attachmentUrl: AttachmentUrl) =>
  render(AttachmentThumb, { clientId: "alex", fileKey: KEY, attachmentUrl });

it("fetches nothing for a chip that is not near the viewport", async () => {
  neverFires();
  const el = thumb(serves);
  await settle();

  // The case that fails against the component this replaced, which called the host on mount.
  expect(asked).toEqual([]);
  expect(el.querySelector("img")).toBeNull();
  // And it does not read as broken: a faded glyph, not the warning and not an empty box.
  expect(el.querySelector(".pending")).not.toBeNull();
  expect(el.querySelector(".failed")).toBeNull();
});

it("fetches once and renders when the chip comes into view", async () => {
  const obs = onDemand();
  const el = thumb(serves);
  await settle();
  expect(asked).toEqual([]);

  obs.fire();
  await settle();

  expect(asked).toEqual([KEY]);
  expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:thumb-bytes");
  expect(el.querySelector(".pending")).toBeNull();
});

it("stops observing once it has fetched, so a chip costs one fetch however it is scrolled", async () => {
  const obs = onDemand();
  thumb(serves);
  await settle();

  obs.fire();
  await settle();
  expect(obs.disconnects).toHaveBeenCalled();

  // A strip is overflow-x: auto inside a scrolling page, so a chip crosses the margin repeatedly.
  obs.fire();
  await settle();
  expect(asked).toEqual([KEY]);
});

it("disconnects its observer when the chip is unmounted", () => {
  const disconnects = neverFires();
  // Mounted by hand rather than through render(): this case is about the teardown, and the helper's
  // own unmount runs in afterEach, which is after every assertion a case can make.
  const target = document.body.appendChild(document.createElement("div"));
  const app = mount(AttachmentThumb, { target, props: { clientId: "alex", fileKey: KEY, attachmentUrl: serves } });
  flushSync();
  expect(disconnects).not.toHaveBeenCalled();

  unmount(app, { outro: false });
  flushSync();
  // A list of many rows mounts and unmounts strips as it filters; an observer per chip left behind
  // holds its element alive and keeps answering.
  expect(disconnects).toHaveBeenCalled();
});
