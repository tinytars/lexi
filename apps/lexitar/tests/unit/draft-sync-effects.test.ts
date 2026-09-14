// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { flushSync } from "svelte";
import { withEffectRoot, box } from "./_effect-root.svelte";
import { createDraftSync } from "../../src/lib/draft-sync.svelte";
import type { Client } from "../../src/lib/types";

// W71 — the resync effect, which decides when a patient's in-progress edit is thrown away and rebuilt
// from the parent's prop. Nine CRUD tabs share it, and it had never been executed by a test: `$effect`
// did not run in this suite at all until the browser resolution condition and jsdom landed together.
//
// Everything here is about the DRAFT the patient is typing into, because that is the thing that gets
// lost. The jsdom docblock above is load-bearing: without it these all pass vacuously.

const client = (over: Partial<Client> = {}): Client =>
  ({ displayName: "P", watchlist: [], results: [], factors: { goal: "g" }, ...over }) as Client;

let cleanup: (() => void)[] = [];
afterEach(() => { for (const d of cleanup) d(); cleanup = []; });

function harness(initial: Client, canEdit?: () => boolean) {
  const current = box(initial);
  const saveError = box<unknown>(null);
  const built = vi.fn((c: Client) => ({ ...c }) as Client);
  const root = withEffectRoot(() =>
    canEdit
      ? createDraftSync(() => current.value, built, () => saveError.value, canEdit)
      : createDraftSync(() => current.value, built, () => saveError.value),
  );
  cleanup.push(root.destroy);
  flushSync();
  return {
    get ds() { return root.value; },
    built,
    set(next: Client) { current.value = next; flushSync(); },
    fail(e: unknown) { saveError.value = e; flushSync(); },
    get current() { return current.value; },
  };
}

describe("the effect actually runs", () => {
  // The canary. If this fails, every other assertion in this file is meaningless rather than wrong —
  // exactly the state the suite was in before jsdom.
  it("rebuilds the draft when a new client arrives", () => {
    const h = harness(client());
    const calls = h.built.mock.calls.length;
    h.set(client({ displayName: "Liz" }));
    expect(h.built.mock.calls.length).toBeGreaterThan(calls);
    expect(h.ds.draft!.displayName).toBe("Liz");
  });
});

describe("an in-progress edit is not thrown away", () => {
  // The case that loses work. A Finding regeneration replaces `client` while the patient is
  // mid-sentence; resyncing on it would discard what they typed, with no error and nothing to notice.
  it("a finding-only change does not resync", () => {
    const h = harness(client());
    const calls = h.built.mock.calls.length;
    h.set({ ...h.current, finding: { disease: [] } } as unknown as Client);
    expect(h.built.mock.calls.length).toBe(calls);
  });

  it("but a change to any other key does", () => {
    const h = harness(client());
    h.set({ ...h.current, watchlist: ["ApoB"] } as Client);
    expect(h.ds.draft!.watchlist).toEqual(["ApoB"]);
  });

  it("the same object handed back is not a change", () => {
    const h = harness(client());
    const calls = h.built.mock.calls.length;
    h.set(h.current);
    expect(h.built.mock.calls.length).toBe(calls);
  });
});

describe("skipNextResync covers exactly one echo", () => {
  it("the save's own echo does not rebuild the draft", () => {
    const h = harness(client());
    const calls = h.built.mock.calls.length;
    h.ds.skipNextResync();
    h.set(client({ displayName: "the parent's echo" }));
    expect(h.built.mock.calls.length).toBe(calls);
  });

  it("and the next change DOES — the skip is consumed, not sticky", () => {
    const h = harness(client());
    h.ds.skipNextResync();
    h.set(client({ displayName: "echo" }));
    h.set(client({ displayName: "a real later change" }));
    expect(h.ds.draft!.displayName).toBe("a real later change");
  });

  // If the save FAILED there is no echo coming, so a pending skip would swallow the next legitimate
  // resync instead and the draft would silently stop tracking the client.
  it("a save error clears a pending skip", () => {
    const h = harness(client());
    h.ds.skipNextResync();
    h.fail(new Error("save failed"));
    h.set(client({ displayName: "after the failure" }));
    expect(h.ds.draft!.displayName).toBe("after the failure");
  });
});

describe("the gated variant refuses a draft a host cannot edit", () => {
  it("starts null when editing is not allowed", () => {
    expect(harness(client(), () => false).ds.draft).toBeNull();
  });

  it("nulls the draft on resync rather than rebuilding one", () => {
    let allowed = true;
    const h = harness(client(), () => allowed);
    expect(h.ds.draft).not.toBeNull();
    allowed = false;
    h.set(client({ displayName: "read-only now" }));
    expect(h.ds.draft).toBeNull();
  });

  it("and builds one once editing is allowed again", () => {
    let allowed = false;
    const h = harness(client(), () => allowed);
    allowed = true;
    h.set(client({ displayName: "editable" }));
    expect(h.ds.draft!.displayName).toBe("editable");
  });
});
