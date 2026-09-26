// @vitest-environment jsdom
// The async URL binding every attachment surface renders through. jsdom and the browser condition
// (vitest.config.ts) because $effect is compiled away in Svelte's server build and would never run.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import { resolveAttachmentUrl, type AttachmentUrl } from "@tinytars/frame/attachment-url.svelte";
import { box, effectRoot } from "./runes.svelte";

const cleanups: Array<() => void> = [];

/** One binding, outside a component, with its effects flushed on demand. */
function bind(url: AttachmentUrl, source: () => { clientId: string | null; key: string | null }) {
  const { value, stop } = effectRoot(() => resolveAttachmentUrl(() => ({ url, ...source() })));
  cleanups.push(stop);
  flushSync();
  return value;
}

/** The URL arrives a microtask later, so a settled promise needs one turn before it is readable. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
});

describe("resolveAttachmentUrl", () => {
  it("publishes the URL once it resolves, with no error", async () => {
    const binding = bind(async () => "blob:ok", () => ({ clientId: "alex", key: "one.pdf" }));

    await settle();

    expect(binding.current).toBe("blob:ok");
    expect(binding.error).toBeUndefined();
  });

  // The defect this pins: a rejection used to leave `current` undefined forever, which every
  // consumer renders as "not loaded yet" — a blank thumbnail and a download link pointing at "#".
  it("reports a rejection instead of staying silently unresolved", async () => {
    const binding = bind(
      async () => {
        throw new Error('no content key for "one.pdf"');
      },
      () => ({ clientId: "alex", key: "one.pdf" }),
    );

    await settle();

    expect(binding.current).toBeUndefined();
    expect(binding.error).toBe('no content key for "one.pdf"');
  });

  it("describes a rejection that carries no message", async () => {
    const binding = bind(() => Promise.reject("nope"), () => ({ clientId: "alex", key: "one.pdf" }));

    await settle();

    expect(binding.error).toBe("Couldn't open this attachment.");
  });

  // The viewer's arrows move through the strip without remounting, so a failure on one attachment
  // must not caption the next.
  it("clears a previous failure when the attachment changes", async () => {
    const key = box("broken.pdf");
    const binding = bind(
      async (_id, k) => {
        if (k === "broken.pdf") throw new Error("broken");
        return "blob:ok";
      },
      () => ({ clientId: "alex", key: key.current }),
    );
    await settle();
    expect(binding.error).toBe("broken");

    key.current = "fine.pdf";
    await settle();

    expect(binding.error).toBeUndefined();
    expect(binding.current).toBe("blob:ok");
  });

  it("resolves nothing at all without a client and a key", async () => {
    const binding = bind(async () => "blob:ok", () => ({ clientId: null, key: null }));

    await settle();

    expect(binding.current).toBeUndefined();
    expect(binding.error).toBeUndefined();
  });
});
