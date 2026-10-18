// W75 — two stores share one backup bucket, and snapshot ids are timestamps. Before this, the
// retention prune listed `manifests/` globally and deleted everything past --keep, so dev's nightly
// would have deleted prod's only backup; and one global latest.json meant the freshness alarm
// reported green for a store that had never been snapshotted at all. Both are store-scoped now, and
// these tests are what says so.
//
// R2 is substituted in memory at the vault-sync module boundary (the pattern vault-restore.test.ts
// uses) — the real prune/listSnapshotIds/checkFreshness logic runs against it.

import { describe, it, expect, beforeEach, vi } from "vitest";

const store = await vi.hoisted(async () => (await import("../support/object-store")).memoryObjectStore());
const r2 = store.objects;

vi.mock("../../scripts/vault-sync", async (importOriginal) => {
  const { getObject, putObject, listObjects, deleteObject } = store;
  return { ...(await importOriginal<typeof import("../../scripts/vault-sync")>()), getObject, putObject, listObjects, deleteObject };
});

import { BACKUP_BUCKET } from "../../scripts/vault-sync";
import { prune, listSnapshotIds, manifestKey, snapshotPrefix, latestKey } from "../../scripts/vault-snapshot";
import { checkFreshness } from "../../scripts/vault-snapshot-check";

const put = (key: string, text = "x") => r2.set(`${BACKUP_BUCKET}::${key}`, new TextEncoder().encode(text));
const has = (key: string) => r2.has(`${BACKUP_BUCKET}::${key}`);

// A complete snapshot is a body under snapshots/{id}/ plus the manifest that references it.
function seedSnapshot(store: string, id: string): void {
  put(`${snapshotPrefix(store, id)}r2/${store}/data-a.enc`);
  put(manifestKey(store, id), JSON.stringify({ snapshotId: id, store }));
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `2026-08-0${i + 1}T03-15-00Z`);

beforeEach(() => r2.clear());

describe("retention is scoped to one store", () => {
  it("prunes only the store it was asked about, however much fresher the other store's snapshots are", async () => {
    // dev is the store with the nightly, so its ids are the newest in the bucket. prod has one
    // snapshot, older than every dev one — exactly the shape that deleted it under a global sort.
    for (const id of ids(5)) seedSnapshot("dev", id);
    seedSnapshot("prod", "2026-07-01T03-15-00Z");

    const { pruned } = await prune(2, new Date("2026-08-06T00:00:00Z"), "dev");

    expect(pruned).toEqual(ids(5).slice(0, 3));
    expect(await listSnapshotIds("dev")).toEqual(ids(5).slice(3));
    expect(await listSnapshotIds("prod")).toEqual(["2026-07-01T03-15-00Z"]);
    expect(has(manifestKey("prod", "2026-07-01T03-15-00Z"))).toBe(true);
    expect(has(`${snapshotPrefix("prod", "2026-07-01T03-15-00Z")}r2/prod/data-a.enc`)).toBe(true);
  });

  it("sweeps only its own store's aborted runs", async () => {
    const stale = "2026-08-01T03-15-00Z";
    put(`${snapshotPrefix("dev", stale)}r2/dev/data-a.enc`); // bodies, no manifest = died partway
    put(`${snapshotPrefix("prod", stale)}r2/prod/data-a.enc`);
    seedSnapshot("dev", "2026-08-05T03-15-00Z");

    const { incomplete } = await prune(5, new Date("2026-08-06T00:00:00Z"), "dev");

    expect(incomplete).toEqual([stale]);
    expect(has(`${snapshotPrefix("dev", stale)}r2/dev/data-a.enc`)).toBe(false);
    expect(has(`${snapshotPrefix("prod", stale)}r2/prod/data-a.enc`)).toBe(true);
  });

  it("never deletes a latest.json", async () => {
    for (const id of ids(3)) seedSnapshot("dev", id);
    put(latestKey("dev"), JSON.stringify({ snapshotId: ids(3)[2], store: "dev" }));
    await prune(1, new Date("2026-08-06T00:00:00Z"), "dev");
    expect(has(latestKey("dev"))).toBe(true);
  });
});

describe("the freshness alarm reads its own store", () => {
  const now = new Date("2026-08-06T00:00:00Z");
  const fresh = { snapshotId: "2026-08-05T03-15-00Z", store: "dev", createdAt: "2026-08-05T03:15:00Z" };

  it("does not report a store green on another store's nightly", async () => {
    seedSnapshot("dev", fresh.snapshotId);
    put(latestKey("dev"), JSON.stringify(fresh));

    expect((await checkFreshness(36, now, "dev")).ok).toBe(true);

    const prod = await checkFreshness(36, now, "prod");
    expect(prod.ok).toBe(false);
    expect(prod.reason).toMatch(/no snapshot has ever completed for store "prod"/);
  });

  it("refuses a pointer written from a different store rather than trusting the filename", async () => {
    seedSnapshot("prod", fresh.snapshotId);
    put(latestKey("prod"), JSON.stringify({ ...fresh, store: "dev" }));

    const report = await checkFreshness(36, now, "prod");
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/written from store "dev"/);
  });

  it("fails when the pointer is fresh but retention has already deleted its manifest", async () => {
    put(latestKey("dev"), JSON.stringify(fresh));
    const report = await checkFreshness(36, now, "dev");
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/manifest is missing/);
  });
});
