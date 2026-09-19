import { describe, it, expect } from "vitest";
import { installErrorReporter, type ClientErrorPayload } from "../../src/lib/error-reporter";
import { lazyImport } from "../../src/lib/lazy-import";

const fire = (target: EventTarget, type: string, props: Record<string, unknown>) =>
  target.dispatchEvent(Object.assign(new Event(type), props));

function setup() {
  const target = new EventTarget();
  const sent: ClientErrorPayload[] = [];
  const reloads: number[] = [];
  installErrorReporter(target, (p) => sent.push(p), () => reloads.push(1));
  return { target, sent, reloads };
}

describe("installErrorReporter", () => {
  it("reports an uncaught error with its stack", () => {
    const { target, sent } = setup();
    fire(target, "error", { error: new Error("https://svelte.dev/e/each_key_duplicate") });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "Error", message: "https://svelte.dev/e/each_key_duplicate" });
    expect(sent[0].stack).toContain("error-reporter.test.ts");
    expect(typeof sent[0].build).toBe("string");
  });

  it("reports an unhandled rejection, including a non-Error reason", () => {
    const { target, sent } = setup();
    fire(target, "unhandledrejection", { reason: new TypeError("x is undefined") });
    fire(target, "unhandledrejection", { reason: "plain string" });
    expect(sent.map((p) => `${p.name}: ${p.message}`)).toEqual(["TypeError: x is undefined", "Error: plain string"]);
  });

  it("reports a crash repeating every render once, and caps distinct reports per page", () => {
    const { target, sent } = setup();
    for (let i = 0; i < 50; i++) fire(target, "error", { error: new Error("same") });
    for (let i = 0; i < 50; i++) fire(target, "error", { error: new Error(`distinct ${i}`) });
    expect(sent.map((p) => p.message)).toEqual(["same", "distinct 0", "distinct 1", "distinct 2", "distinct 3"]);
  });

  it("ignores an opaque cross-origin 'Script error.' that carries no Error", () => {
    const { target, sent } = setup();
    fire(target, "error", { message: "Script error.", error: null });
    expect(sent).toEqual([]);
  });

  it("reports a lazy chunk that fails to load even when the caller catches it, then reloads onto the current build", async () => {
    const { sent, reloads } = setup();
    const stale = new TypeError("Failed to fetch dynamically imported module: /assets/pdf-OLD.js");
    await expect(lazyImport(() => Promise.reject(stale))).rejects.toBe(stale);
    expect(sent.map((p) => `${p.name}: ${p.message}`)).toEqual([`TypeError: ${stale.message}`]);
    expect(reloads).toHaveLength(1);
  });

  it("does not reload for an ordinary uncaught error", () => {
    const { target, reloads } = setup();
    fire(target, "error", { error: new Error("boom") });
    expect(reloads).toEqual([]);
  });
});
