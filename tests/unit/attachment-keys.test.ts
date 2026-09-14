import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachmentKeysOf,
  attachmentsOf,
  groupAttachmentsOf,
  isLastRawCaptureAttachment,
  isLastRawCaptureHolder,
} from "../../src/lib/attachment-keys";
import type { Attachment, TreatmentItem } from "../../src/lib/types";

// W71 — `attachmentKeysOf` was untested, and scripts/commands/reconcile.ts uses it to decide which R2
// objects to fetch while scripts/vault-verify.ts uses it to decide which the repo is FAULTED for not
// having. An owner it forgets is an attachment that is never materialised and then reported missing
// forever — which is exactly the bug its own comment records: verify covered seven owners, reconcile
// covered none, so a vault pulled from R2 referenced attachments the repo could never satisfy.
//
// The precedent is store-key-classes.test.ts, which exists because a DIFFERENT key-classification
// function silently broke five nights of backups. Same shape of function, same shape of test: derive
// the expectation from the OTHER side of the invariant rather than restating this side's list.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const att = (key: string): Attachment => ({ key, name: key, mediaType: "image/png", bytes: 1, addedAt: "" });

/**
 * Every interface in types.ts that can carry attachments, read from the type source.
 *
 * This is the other side of the invariant: a new entity kind that gains `attachments?: Attachment[]`
 * appears here the moment it is declared, whether or not anyone remembered attachmentKeysOf.
 */
function attachmentBearingTypes(): string[] {
  const src = readFileSync(join(ROOT, "../../brain/akesi-pil/types.ts"), "utf8");
  const out: string[] = [];
  let current = "";
  for (const line of src.split("\n")) {
    const decl = line.match(/^export interface (\w+)/);
    if (decl) current = decl[1];
    if (/^\s*attachments\?: Attachment\[\];/.test(line) && current) out.push(current);
  }
  return [...new Set(out)];
}

/** The factors/study list each attachment-bearing type lives in. */
const OWNER_LIST: Record<string, (a: Attachment[]) => Record<string, unknown>> = {
  TreatmentItem: (a) => ({ factors: { treatments: [{ id: "t1", attachments: a }] } }),
  NoteEntry: (a) => ({ factors: { noteEntries: [{ id: "n1", attachments: a }] } }),
  DecisionEntry: (a) => ({ factors: { decisions: [{ id: "d1", attachments: a }] } }),
  AllergyEntry: (a) => ({ factors: { allergies: [{ id: "a1", attachments: a }] } }),
  FamilyHistoryEntry: (a) => ({ factors: { familyHistory: [{ id: "f1", attachments: a }] } }),
  DiseaseEntry: (a) => ({ factors: { diseases: [{ id: "dx1", attachments: a }] } }),
  StudyEntry: (a) => ({ study: { entries: [{ id: "s1", attachments: a }] } }),
};

describe("every attachment owner is enumerated", () => {
  it("the test knows about every type that can carry attachments", () => {
    // Guards the guard: a new attachment-bearing type fails HERE first, with a message naming it,
    // rather than silently not being exercised below.
    expect(attachmentBearingTypes().sort()).toEqual(Object.keys(OWNER_LIST).sort());
  });

  it.each(attachmentBearingTypes())("%s's attachments are found", (typeName) => {
    const build = OWNER_LIST[typeName];
    const keys = attachmentKeysOf(build([att("k1"), att("k2")]) as Parameters<typeof attachmentKeysOf>[0]);
    expect(keys.map((k) => k.key)).toEqual(["k1", "k2"]);
    // The label is what a reconcile failure prints; a blank one makes the message useless.
    for (const k of keys) expect(k.label.trim().length).toBeGreaterThan(0);
  });

  it("finds them all at once, across every owner", () => {
    const client = { factors: {}, study: { entries: [] } } as Record<string, Record<string, unknown>>;
    const expected: string[] = [];
    for (const [i, typeName] of attachmentBearingTypes().entries()) {
      const key = `key-${i}`;
      expected.push(key);
      const built = OWNER_LIST[typeName]([att(key)]);
      for (const [top, val] of Object.entries(built)) client[top] = { ...client[top], ...(val as object) };
    }
    const found = attachmentKeysOf(client as Parameters<typeof attachmentKeysOf>[0]).map((k) => k.key);
    expect(found.sort()).toEqual(expected.sort());
  });

  it("an empty client yields nothing rather than throwing", () => {
    expect(attachmentKeysOf({})).toEqual([]);
    expect(attachmentKeysOf({ factors: {}, study: {} })).toEqual([]);
  });

  it("includes the legacy treatment `images` shape, which reconcile must still fetch", () => {
    // An un-migrated vault stores photos as string keys. Missing them here means the files exist in
    // R2, are still rendered by the UI, and are never pulled — a permanent verify fault.
    const keys = attachmentKeysOf({ factors: { treatments: [{ id: "t1", images: ["ab12-photo.jpg"] }] } });
    expect(keys.map((k) => k.key)).toEqual(["ab12-photo.jpg"]);
  });

  it("does not de-duplicate across owners — two rows sharing a file are two claims on it", () => {
    const keys = attachmentKeysOf({
      factors: { noteEntries: [{ id: "n1", attachments: [att("same")] }], allergies: [{ id: "a1", attachments: [att("same")] }] },
    });
    expect(keys.map((k) => k.key)).toEqual(["same", "same"]);
    expect(new Set(keys.map((k) => k.label)).size).toBe(2);
  });
});

describe("attachmentsOf folds the legacy shape without inventing one", () => {
  it("prefers `attachments` when present, ignoring `images` entirely", () => {
    expect(attachmentsOf({ attachments: [att("new")], images: ["old"] }).map((a) => a.key)).toEqual(["new"]);
  });

  it("derives a name and media type from a legacy key", () => {
    const [a] = attachmentsOf({ images: ["ab12cd34-scan.pdf"] });
    expect(a).toMatchObject({ key: "ab12cd34-scan.pdf", name: "scan.pdf", mediaType: "application/pdf" });
  });

  it("falls back to octet-stream for an extension it does not know", () => {
    expect(attachmentsOf({ images: ["ab12-thing.xyz"] })[0].mediaType).toBe("application/octet-stream");
  });

  it("neither field means no attachments", () => {
    expect(attachmentsOf({})).toEqual([]);
  });
});

describe("groupAttachmentsOf unions a medicine's dose rows", () => {
  it("de-duplicates by key, so a photo mirrored onto every row appears once", () => {
    const rows = [{ attachments: [att("photo"), att("coa")] }, { attachments: [att("photo")] }];
    expect(groupAttachmentsOf(rows).map((a) => a.key)).toEqual(["photo", "coa"]);
  });

  it("keeps the first occurrence, so the union is stable as rows are added", () => {
    const first = { ...att("photo"), name: "first.png" };
    const second = { ...att("photo"), name: "second.png" };
    expect(groupAttachmentsOf([{ attachments: [first] }, { attachments: [second] }])[0].name).toBe("first.png");
  });
});

// W78 — the UI guard that blocks removing a saved attachment. Mirrors report-merge.ts's
// provenanceIssues `.some()` threshold deliberately: only losing the LAST claimed raw-capture key is
// blocked, not any claimed key.
describe("isLastRawCaptureAttachment", () => {
  const item = (opts: { attachments: string[]; rawCapture?: string[]; via?: "photo" | "text" }): TreatmentItem =>
    ({
      id: "t1",
      name: "NAC",
      start: "2026-01-01",
      attachments: opts.attachments.map(att),
      ...(opts.rawCapture
        ? { extracted: { via: opts.via ?? "photo", at: "2026-08-27T00:00:00.000Z" }, rawCaptureAttachmentKeys: opts.rawCapture }
        : {}),
    } as TreatmentItem);

  it("blocks removing the only surviving claimed key", () => {
    expect(isLastRawCaptureAttachment(item({ attachments: ["a"], rawCapture: ["a"] }), "a")).toBe(true);
  });

  it("allows removing one of several surviving claimed keys", () => {
    expect(isLastRawCaptureAttachment(item({ attachments: ["a", "b"], rawCapture: ["a", "b"] }), "a")).toBe(false);
  });

  it("allows removing an attachment the extraction never claimed", () => {
    expect(isLastRawCaptureAttachment(item({ attachments: ["a", "b"], rawCapture: ["a"] }), "b")).toBe(false);
  });

  it("never blocks on an item that wasn't photo-extracted", () => {
    expect(isLastRawCaptureAttachment(item({ attachments: ["a"] }), "a")).toBe(false);
  });

  it("never blocks a text-extracted item, even with rawCaptureAttachmentKeys set", () => {
    expect(isLastRawCaptureAttachment(item({ attachments: ["a"], rawCapture: ["a"], via: "text" }), "a")).toBe(false);
  });

  it("does not block removing a key already absent from the claim (already lost some other way)", () => {
    expect(isLastRawCaptureAttachment(item({ attachments: ["a", "b"], rawCapture: ["c"] }), "a")).toBe(false);
  });
});

// W78 — deleteTreatment's data-loss guard: unlike isLastRawCaptureAttachment, this checks across the
// whole medicine group (siblings sharing a trimmed/lowercased name), since deleting a row removes it
// from provenanceIssues' consideration entirely rather than leaving it in violation.
describe("isLastRawCaptureHolder", () => {
  const row = (opts: { id: string; name: string; attachments: string[]; rawCapture?: string[] }): TreatmentItem =>
    ({
      id: opts.id,
      name: opts.name,
      start: "2026-01-01",
      attachments: opts.attachments.map(att),
      ...(opts.rawCapture
        ? { extracted: { via: "photo" as const, at: "2026-08-27T00:00:00.000Z" }, rawCaptureAttachmentKeys: opts.rawCapture }
        : {}),
    } as TreatmentItem);

  it("returns true when no sibling still holds a raw capture", () => {
    const target = row({ id: "1", name: "NAC", attachments: ["a"], rawCapture: ["a"] });
    const sibling = row({ id: "2", name: "NAC", attachments: ["b"] });
    expect(isLastRawCaptureHolder(target, [target, sibling])).toBe(true);
  });

  it("returns false when a sibling (matched by trimmed/lowercased name) still holds one", () => {
    const target = row({ id: "1", name: "NAC", attachments: ["a"], rawCapture: ["a"] });
    const sibling = row({ id: "2", name: " nac ", attachments: ["b"], rawCapture: ["b"] });
    expect(isLastRawCaptureHolder(target, [target, sibling])).toBe(false);
  });

  it("ignores a same-named sibling that already lost its own raw capture", () => {
    const target = row({ id: "1", name: "NAC", attachments: ["a"], rawCapture: ["a"] });
    const sibling = row({ id: "2", name: "NAC", attachments: [], rawCapture: ["b"] });
    expect(isLastRawCaptureHolder(target, [target, sibling])).toBe(true);
  });

  it("does not compare the item against itself", () => {
    const target = row({ id: "1", name: "NAC", attachments: ["a"], rawCapture: ["a"] });
    expect(isLastRawCaptureHolder(target, [target])).toBe(true);
  });

  it("returns false for an item that never held a raw capture — nothing to lose", () => {
    const target = row({ id: "1", name: "NAC", attachments: ["a"] });
    expect(isLastRawCaptureHolder(target, [target])).toBe(false);
  });

  it("ignores a differently-named sibling even if it holds a raw capture", () => {
    const target = row({ id: "1", name: "NAC", attachments: ["a"], rawCapture: ["a"] });
    const other = row({ id: "2", name: "Ezetimibe", attachments: ["c"], rawCapture: ["c"] });
    expect(isLastRawCaptureHolder(target, [target, other])).toBe(true);
  });
});
