import { mount, unmount, flushSync, type Component } from "svelte";
import { afterEach } from "vitest";

// jsdom has no layout, so nothing would ever be observed anyway.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

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
