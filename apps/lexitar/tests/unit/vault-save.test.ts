import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createVaultSave as create } from "../../src/lib/vault-save.svelte";

// W68 — the first unit tests this module has ever had. It was written in W67 and shipped on the
// strength of e2e alone, and during that work I introduced a bug here and caught it by reading rather
// than by testing: a shared slot meant two edits queued before the first PUT resolved would BOTH write
// the second snapshot. Nothing in 1544 unit tests or 217 e2e specs would have failed. The first test
// below is that bug.

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// Every save here gets a collecting reporter rather than the real one, which would POST to
// /api/client-error from a unit test.
const reported: Error[] = [];
beforeEach(() => (reported.length = 0));
const createVaultSave = () => create((e) => reported.push(e));

describe("vault-save: the queue writes what each caller handed it", () => {
  it("two pushes queued before the first resolves write their OWN snapshots, in order", async () => {
    const vs = createVaultSave();
    const written: string[] = [];
    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((r) => (releaseFirst = r));

    // Queue both while the first is still in flight — the M57 case this module exists for.
    vs.push(async () => {
      await firstInFlight;
      written.push("edit-A");
    });
    vs.push(async () => {
      written.push("edit-B");
    });

    expect(written).toEqual([]); // nothing written while the first is blocked
    releaseFirst();
    await flush();

    expect(written).toEqual(["edit-A", "edit-B"]);
  });

  it("serializes — the second write does not start until the first settles", async () => {
    const vs = createVaultSave();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    vs.push(async () => {
      order.push("A:start");
      await gate;
      order.push("A:end");
    });
    vs.push(async () => {
      order.push("B:start");
    });

    await flush();
    expect(order).toEqual(["A:start"]); // B has not begun
    release();
    await flush();
    expect(order).toEqual(["A:start", "A:end", "B:start"]);
  });
});

describe("vault-save: what the user sees", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flashes saved, then clears it after the timer", async () => {
    const vs = createVaultSave();
    expect(vs.saved).toBe(false);

    vs.push(async () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vs.saved).toBe(true);

    await vi.advanceTimersByTimeAsync(1999);
    expect(vs.saved).toBe(true); // still flashing
    await vi.advanceTimersByTimeAsync(1);
    expect(vs.saved).toBe(false);
  });

  it("a failed write reports the error and does not claim saved", async () => {
    const vs = createVaultSave();
    vs.push(async () => {
      throw new Error("R2 said no");
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(vs.error).toBe("R2 said no");
    expect(vs.saved).toBe(false);
  });

  it("a failure does not poison the queue — the next write still runs and clears the error", async () => {
    const vs = createVaultSave();
    const written: string[] = [];

    vs.push(async () => {
      throw new Error("transient");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vs.error).toBe("transient");

    vs.push(async () => {
      written.push("after-failure");
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(written).toEqual(["after-failure"]);
    expect(vs.error).toBe(null);
    expect(vs.saved).toBe(true);
  });

  // Why push() must clearTimeout before arming a new flash: an uncleared timer from an EARLIER save
  // fires during a LATER one and cuts it short, so the user's "saved" tick vanishes after a fraction
  // of its two seconds. Rapid consecutive edits are the normal case here, not an edge one.
  it("a rapid second save gets its own full flash, not the remainder of the first", async () => {
    const vs = createVaultSave();

    vs.push(async () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vs.saved).toBe(true); // flash #1 would end at t=2000

    await vi.advanceTimersByTimeAsync(1000);
    vs.push(async () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vs.saved).toBe(true); // flash #2 should run to t=3000

    await vi.advanceTimersByTimeAsync(1000); // t=2000 — flash #1's timer would fire here
    expect(vs.saved).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // t=3000 — flash #2's own timer
    expect(vs.saved).toBe(false);
  });
});

// W70 1d — a failed save must stay visible, and be retryable without undoing later edits.
describe("a failed save survives, and retry replays the LATEST write", () => {
  it("the error is NOT erased by the next push", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(new Error("network down")));
    await flush();
    expect(vs.error).toBe("network down");

    // The old behaviour cleared the error at the top of push(), so the next edit erased the only
    // evidence that a write had failed — while the UI already showed the change as applied.
    vs.push(() => new Promise<void>(() => {})); // queued, never settles
    expect(vs.error).toBe("network down");
  });

  it("the error clears on a SUCCESS, not on an attempt", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(new Error("nope")));
    await flush();
    expect(vs.error).toBe("nope");

    vs.push(() => Promise.resolve());
    await flush();
    expect(vs.error).toBeNull();
    expect(vs.saved).toBe(true);
  });

  it("canRetry is false until something has actually failed", async () => {
    const vs = createVaultSave();
    expect(vs.canRetry).toBe(false);
    vs.push(() => Promise.resolve());
    await flush();
    expect(vs.canRetry).toBe(false);
    vs.push(() => Promise.reject(new Error("x")));
    await flush();
    expect(vs.canRetry).toBe(true);
  });

  // The assertion that makes retry safe. Writes serialize the WHOLE vault, so the newest closure
  // already contains the failed edit's bytes plus everything since. Replaying the FAILED closure would
  // write a superseded snapshot and silently undo later edits — a second data-loss bug wearing the
  // costume of a fix.
  it("retry replays the newest closure, never the one that failed", async () => {
    const vs = createVaultSave();
    const written: string[] = [];
    vs.push(() => Promise.reject(new Error("first failed")));
    await flush();
    // A later edit is queued and also fails (still offline), so `error` stays set.
    vs.push(() => {
      written.push("second");
      return Promise.reject(new Error("second failed"));
    });
    await flush();
    expect(vs.error).toBe("second failed");

    written.length = 0;
    vs.retry();
    await flush();
    expect(written).toEqual(["second"]); // NOT the first, superseded snapshot
  });

  it("retry is a no-op when nothing has failed", async () => {
    const vs = createVaultSave();
    let calls = 0;
    vs.push(() => {
      calls++;
      return Promise.resolve();
    });
    await flush();
    vs.retry();
    await flush();
    expect(calls).toBe(1);
  });
});

// The vault PUT's rejection is caught here and shown as a banner, so it never reaches the window
// handlers the error reporter listens on — a save silently failing for a real user was invisible.
describe("a failed save is filed, not just displayed", () => {
  it("reports the failure under a name that groups its issues", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(new Error("Failed to fetch")));
    await flush();

    expect(reported.map((e) => `${e.name}: ${e.message}`)).toEqual(["VaultSaveFailed: Failed to fetch"]);
  });

  it("reports nothing when writes succeed", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.resolve());
    await flush();

    expect(reported).toEqual([]);
  });
});
