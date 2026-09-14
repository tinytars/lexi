import { describe, it, expect, vi } from "vitest";
import { createPersistNow } from "../../src/lib/draft-sync.svelte";
import type { Client } from "../../src/lib/types";
import type { DraftSync } from "../../src/lib/draft-sync.svelte";

// W71 — draft-sync.svelte.ts had no tests, and it is the mechanism whose failure mode is a silently
// lost patient edit: nine CRUD tabs share it.
//
// This covers createPersistNow, which is a plain factory — no runes — and is where the rule "persist
// a COPY, never the live client" lives. Getting that wrong means a mutation intended for the save
// payload lands on the object the UI is still rendering from.
//
// NOT covered here, and it is not an oversight: createDraftSync's resync logic lives in an `$effect`,
// and `$effect` does not run in this suite at all. The Svelte plugin in vitest.config.ts compiles
// `$state` (which is why menu-registry and vault-save are testable) but effects are compiled away
// under vitest's node environment, so an `$effect.root` callback never fires. Verified directly, not
// assumed. Reaching them needs a DOM environment (jsdom/happy-dom), which is a new dependency and a
// decision for the owner — see the W71 notes. The DECISION the effect makes is separately covered:
// shouldResyncDraft, including the finding-only rule that protects an in-progress edit, is tested in
// client-resync.test.ts.

const client = (over: Partial<Client> = {}): Client =>
  ({ displayName: "P", watchlist: [], results: [], factors: { goal: "g" }, ...over }) as Client;

/** A stand-in for the rune factory's return value — persistNow only ever calls skipNextResync. */
function stubDraftSync() {
  const skips: number[] = [];
  return {
    ds: { get draft() { return client(); }, skipNextResync: () => skips.push(1) } as DraftSync,
    get skipCount() { return skips.length; },
  };
}

describe("persistNow saves a copy, never the live client", () => {
  it("hands onSave the mutated payload", () => {
    const live = client();
    const onSave = vi.fn();
    createPersistNow(stubDraftSync().ds, () => live, onSave)((p) => { p.displayName = "edited"; });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].displayName).toBe("edited");
  });

  it("and leaves the live client untouched", () => {
    // The whole reason a baseline clone exists. Without it the mutation lands on the object the UI is
    // still rendering from, and the "save" appears to work whether or not it reaches the vault.
    const live = client({ factors: { goal: "original" } });
    createPersistNow(stubDraftSync().ds, () => live, vi.fn())((p) => {
      p.displayName = "edited";
      p.factors!.goal = "changed";
    });

    expect(live.displayName).toBe("P");
    expect(live.factors!.goal).toBe("original");
  });

  it("clones DEEPLY, so a nested mutation cannot reach the live client either", () => {
    const live = client({ factors: { goal: "original", focus: "lipids" } });
    createPersistNow(stubDraftSync().ds, () => live, vi.fn())((p) => { p.factors!.focus = "renal"; });
    expect(live.factors!.focus).toBe("lipids");
  });

  it("normalizes before saving", () => {
    const onSave = vi.fn();
    const live = client({ watchlist: ["  ApoB  ", "ApoB", ""] });
    createPersistNow(stubDraftSync().ds, () => live, onSave)(() => {});
    // Trimmed, de-duplicated, blanks dropped — the vault never sees the raw input.
    expect(onSave.mock.calls[0][0].watchlist).toEqual(["ApoB"]);
  });

  it("skips the next resync, so the parent's echo of this save does not rebuild the draft", () => {
    const stub = stubDraftSync();
    createPersistNow(stub.ds, () => client(), vi.fn())(() => {});
    expect(stub.skipCount).toBe(1);
  });

  it("skips BEFORE calling onSave, not after", () => {
    // onSave is what triggers the parent's re-render. Ordering these the other way leaves a window in
    // which the echo arrives with no skip pending and the draft is rebuilt under the cursor.
    const order: string[] = [];
    const ds = { get draft() { return client(); }, skipNextResync: () => order.push("skip") } as DraftSync;
    createPersistNow(ds, () => client(), () => order.push("save"))(() => {});
    expect(order).toEqual(["skip", "save"]);
  });

  it("tolerates a host with no onSave — a read-only tab must not throw", () => {
    expect(() => createPersistNow(stubDraftSync().ds, () => client(), undefined)(() => {})).not.toThrow();
  });

  it("reports the anchor only when one was given", () => {
    const onSaved = vi.fn();
    const persist = createPersistNow(stubDraftSync().ds, () => client(), vi.fn(), onSaved);
    persist(() => {});
    expect(onSaved).not.toHaveBeenCalled();
    persist(() => {}, "note-1");
    expect(onSaved).toHaveBeenCalledWith("note-1");
  });

  it("reports an empty anchor too — \"\" is a real target, not a missing one", () => {
    const onSaved = vi.fn();
    createPersistNow(stubDraftSync().ds, () => client(), vi.fn(), onSaved)(() => {}, "");
    expect(onSaved).toHaveBeenCalledWith("");
  });
});
