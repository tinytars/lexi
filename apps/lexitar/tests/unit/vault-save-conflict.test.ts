import { describe, it, expect, beforeEach } from "vitest";
import { createVaultSave as create } from "../../src/lib/vault-save.svelte";
import { VaultConflictError } from "@tinytars/vault/vault-sink";

// A refused write is not a failed write.
//
// When the blob moved under this tab the sink throws a TYPED VaultConflictError, and its conflict
// hook has already put App's blocking resolve-or-discard dialog on screen: editing is frozen and the
// only two ways forward are the patient's to choose. The save queue used to treat that like any other
// rejection, which did two wrong things at once — it filed the expected outcome with the error
// reporter (a GitHub issue per concurrent-edit event, pinning the promotion gate on a build no fix can
// clear), and it latched `error`, arming the sidebar's "save failed — retry ↻".
//
// That retry is the dangerous half. It replays the newest closure against an UNCHANGED version token,
// so it can only 412 again; and once the patient has resolved the conflict by discarding this tab's
// edits, the closure still held here carries exactly the snapshot they discarded — pressing retry
// writes it back over the version they chose to keep.

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const reported: Error[] = [];
beforeEach(() => (reported.length = 0));
const createVaultSave = () => create((e) => reported.push(e));

const conflict = () => new VaultConflictError("version-the-server-holds");

describe("a refused save is the dialog's business, not the error reporter's", () => {
  it("does not file a conflict as a save failure", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(conflict()));
    await flush();

    expect(reported).toEqual([]);
  });

  it("still files a genuine failure — the suppression is for conflicts only", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(new TypeError("the request never left")));
    await flush();

    expect(reported.map((e) => e.name)).toEqual(["VaultSaveFailed"]);
  });
});

describe("a refused save does not arm the retry button", () => {
  it("leaves canRetry false, so the stale snapshot has no way back onto the server", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(conflict()));
    await flush();

    expect(vs.error).toBeNull();
    expect(vs.canRetry).toBe(false);
  });

  it("retry() after a conflict replays nothing", async () => {
    const vs = createVaultSave();
    let attempts = 0;
    vs.push(() => {
      attempts++;
      return Promise.reject(conflict());
    });
    await flush();

    vs.retry();
    await flush();
    expect(attempts).toBe(1);
  });

  it("a genuine failure is still retryable", async () => {
    const vs = createVaultSave();
    let attempts = 0;
    vs.push(() => {
      attempts++;
      return Promise.reject(new Error("the server is down"));
    });
    await flush();
    expect(vs.canRetry).toBe(true);

    vs.retry();
    await flush();
    expect(attempts).toBe(2);
  });

  it("a conflict does not erase an earlier failure's banner", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(new Error("the server is down")));
    await flush();

    vs.push(() => Promise.reject(conflict()));
    await flush();
    expect(vs.error).toBe("the server is down");
  });
});

describe("everything else about a refused save is unchanged", () => {
  it("resolves false, so a caller awaiting durability still refuses to build on it", async () => {
    const vs = createVaultSave();
    expect(await vs.push(() => Promise.reject(conflict()))).toBe(false);
  });

  it("does not claim the write was saved", async () => {
    const vs = createVaultSave();
    vs.push(() => Promise.reject(conflict()));
    await flush();

    expect(vs.saved).toBe(false);
  });

  it("does not poison the queue — a later write still runs", async () => {
    const vs = createVaultSave();
    const written: string[] = [];

    vs.push(() => Promise.reject(conflict()));
    vs.push(() => {
      written.push("after-conflict");
      return Promise.resolve();
    });
    await flush();

    expect(written).toEqual(["after-conflict"]);
  });
});
