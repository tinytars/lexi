import { describe, it, expect } from "vitest";
import {
  missingAttachments,
  reconcileAttachments,
} from "../../src/lib/attachment-reconcile";
import {
  setMissingAttachments,
  clearMissingAttachments,
  isAttachmentMissing,
  missingAttachmentCount,
} from "@tinytars/frame/missing-attachments.svelte";
import type { Attachment, Client } from "../../src/lib/types";

// The incident this answers: a record in production named thirty-odd attachment keys that the store
// had no row for, every read answered 404, and the only trace was a console line. The two cases that
// matter are not "does the diff work" — they are the two ways a reconcile can lie. Reporting a file
// present when it is gone leaves the reader with an assessment they think is complete; reporting one
// gone when the listing merely could not be read puts a permanent warning on a healthy record, which
// teaches its reader to ignore the real one.

const att = (key: string): Attachment => ({ key, name: key, mediaType: "image/jpeg", bytes: 1, addedAt: "" });

/** A record naming attachments on two different owners, so the walk is not a single-list test. */
function record(treatment: string[], note: string[]): Client {
  return {
    factors: {
      treatments: [{ id: "t1", name: "Thing", attachments: treatment.map(att) }],
      noteEntries: [{ id: "n1", attachments: note.map(att) }],
    },
  } as unknown as Client;
}

describe("missingAttachments", () => {
  it("names only the keys the listing does not hold", () => {
    const named = [
      { label: "treatment t1", key: "aaa-image.jpg" },
      { label: "note n1", key: "bbb-image.jpg" },
    ];
    expect(missingAttachments(named, ["aaa-image.jpg"])).toEqual([
      { label: "note n1", key: "bbb-image.jpg" },
    ]);
  });

  it("reports one absent file once however many entries name it", () => {
    // The medicine-level union mirrors one product photo onto every dose row (attachment-keys.ts),
    // so a single missing file arrives here several times. Counting it per owner would turn one loss
    // into a crowd and make the number meaningless.
    const named = [
      { label: "treatment t1", key: "shared.jpg" },
      { label: "treatment t2", key: "shared.jpg" },
      { label: "note n1", key: "shared.jpg" },
    ];
    expect(missingAttachments(named, [])).toEqual([{ label: "treatment t1", key: "shared.jpg" }]);
  });

  it("holds nothing against a record whose every key is listed", () => {
    const named = [{ label: "note n1", key: "aaa.jpg" }];
    expect(missingAttachments(named, ["aaa.jpg", "an-unreferenced-extra.jpg"])).toEqual([]);
  });
});

describe("reconcileAttachments", () => {
  it("reports a key the store has no record of, with what names it", async () => {
    const r = await reconcileAttachments("ns", record(["gone.jpg"], ["kept.jpg"]), {
      listFiles: async () => ["kept.jpg"],
    });
    expect(r.listed).toBe(true);
    expect(r.named).toBe(2);
    expect(r.missing).toEqual([{ label: "treatment t1", key: "gone.jpg" }]);
  });

  it("an unreadable listing means UNKNOWN, not clean", async () => {
    // The distinction the Reconciliation.listed flag exists for. Offline is the common case, and a
    // caller that cannot tell "all present" from "could not find out" would mark a record with
    // thirty missing files clean on a flaky network.
    const r = await reconcileAttachments("ns", record(["gone.jpg"], []), { listFiles: async () => null });
    expect(r.listed).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.named).toBe(1);
  });

  it("never asks the store about a record that names no attachment", async () => {
    let asked = false;
    const r = await reconcileAttachments("ns", record([], []), {
      listFiles: async () => { asked = true; return []; },
    });
    expect(asked).toBe(false);
    expect(r).toEqual({ named: 0, missing: [], listed: true });
  });

  it("counts distinct keys, not references", async () => {
    const r = await reconcileAttachments("ns", record(["same.jpg"], ["same.jpg"]), {
      listFiles: async () => [],
    });
    expect(r.named).toBe(1);
    expect(r.missing).toHaveLength(1);
  });
});

describe("the missing-attachment registry", () => {
  it("is empty for a host that never asks, so a non-reconciling host renders as before", () => {
    clearMissingAttachments();
    expect(isAttachmentMissing("anything")).toBe(false);
    expect(missingAttachmentCount()).toBe(0);
  });

  it("replaces the set rather than adding to it", () => {
    // Incremental addition could only ever grow the set, which would leave a warning on a file the
    // reader has since re-uploaded — the one state this must not get stuck in.
    setMissingAttachments(["a.jpg", "b.jpg"]);
    expect(missingAttachmentCount()).toBe(2);
    setMissingAttachments(["b.jpg"]);
    expect(isAttachmentMissing("a.jpg")).toBe(false);
    expect(isAttachmentMissing("b.jpg")).toBe(true);
    clearMissingAttachments();
  });
});
