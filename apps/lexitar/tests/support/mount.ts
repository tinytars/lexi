import { mount, unmount, flushSync, type Component } from "svelte";
import { afterEach } from "vitest";

// jsdom has no layout, so nothing would ever be observed anyway.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
// IntersectionObserver is the opposite case, and the difference is load-bearing. jsdom cannot
// compute visibility either — but a component that gates its own work on an intersection
// (AttachmentThumb.svelte, PdfThumbnail.svelte) does NOTHING while the answer never arrives, so a
// no-op shim would quietly turn every mounted assertion about a chip's image into an assertion
// about a component that was never asked to load — attachment-missing-marks.test.ts's first case
// among them, which asserts the host was asked for a key the listing omits. "Everything is
// visible" is the only answer that preserves what those tests measure. It fires from a microtask
// rather than from observe() itself, so the callback does not re-enter the $effect that created it;
// a suite that wants the other answer replaces this global for its own cases.
globalThis.IntersectionObserver ??= class {
  #cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.#cb = cb;
  }
  observe(target: Element) {
    queueMicrotask(() => this.#cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
} as unknown as typeof IntersectionObserver;
// jsdom implements <dialog> but not its modal API.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };

const mounted: Record<string, unknown>[] = [];

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

export function render<P extends Record<string, unknown>>(component: Component<P>, props: P): HTMLElement {
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
}
