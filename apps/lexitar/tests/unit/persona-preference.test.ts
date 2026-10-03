import { describe, it, expect } from "vitest";
import { createPersonaPreference } from "../../src/lib/persona-preference.svelte";
import { DEFAULT_PERSONA, type PersonaId } from "../../src/lib/personas";

/** A load whose answer arrives only when the test lets it — the window a pick can land in. */
function deferredLoad(stored: PersonaId) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { load: () => gate.then(() => stored), release };
}

function harness(stored: PersonaId = DEFAULT_PERSONA) {
  const saved: PersonaId[] = [];
  const errors: string[] = [];
  const gated = deferredLoad(stored);
  const pref = createPersonaPreference({
    load: gated.load,
    save: async (p) => void saved.push(p),
    reportError: (m) => errors.push(m),
  });
  return { pref, saved, errors, release: gated.release };
}

describe("createPersonaPreference", () => {
  it("opens on the default persona until the account has been read", () => {
    expect(harness().pref.current).toBe(DEFAULT_PERSONA);
  });

  it("applies the stored preference on hydrate", async () => {
    const h = harness("cody");
    const hydrating = h.pref.hydrate();
    h.release();
    await hydrating;
    expect(h.pref.current).toBe("cody");
  });

  it("shows the pick at once and writes it to the account", async () => {
    const h = harness();
    await h.pref.choose("cody");
    expect(h.pref.current).toBe("cody");
    expect(h.saved).toEqual(["cody"]);
  });

  it("keeps a pick made while the account read was still in flight", async () => {
    const h = harness("lexi");
    const hydrating = h.pref.hydrate();
    await h.pref.choose("cody");
    h.release();
    await hydrating;
    // The load answered "lexi" because it was sent before the click. The click is newer, so it stands.
    expect(h.pref.current).toBe("cody");
    expect(h.saved).toEqual(["cody"]);
  });

  it("keeps a pick back to the stored value, rather than treating it as no pick at all", async () => {
    const h = harness("cody");
    const hydrating = h.pref.hydrate();
    await h.pref.choose("lexi");
    h.release();
    await hydrating;
    expect(h.pref.current).toBe("lexi");
  });

  it("still applies a later load once the person has stopped picking", async () => {
    const h = harness("cody");
    await h.pref.choose("lexi");
    const hydrating = h.pref.hydrate();
    h.release();
    await hydrating;
    expect(h.pref.current).toBe("cody");
  });

  it("reports a failed write without reverting the picker under the cursor", async () => {
    const errors: string[] = [];
    const pref = createPersonaPreference({
      load: async () => DEFAULT_PERSONA,
      save: async () => {
        throw new Error("could not save your persona");
      },
      reportError: (m) => errors.push(m),
    });
    await pref.choose("cody");
    expect(pref.current).toBe("cody");
    expect(errors).toEqual(["could not save your persona"]);
  });
});
