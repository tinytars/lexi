// W75 — verifySnapshot() is the step that turns the manifest from a claim into evidence, and it had
// no test at all. A manifest is written by the same pass that copies the bytes, so if the copy
// half-failed the manifest still says everything is there; this function is the only thing that
// re-lists both sides and disagrees. Every case below is a way a backup can be incomplete while the
// manifest reads clean.
//
// R2 is substituted in memory at the vault-sync module boundary (the pattern vault-restore.test.ts
// and vault-snapshot-retention.test.ts use) — the real verify logic runs against it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

const store = await vi.hoisted(async () => (await import("../support/object-store")).memoryObjectStore());
const r2 = store.objects;

vi.mock("../../scripts/vault-sync", async (importOriginal) => {
  const { getObject, putObject, listObjects, deleteObject } = store;
  return { ...(await importOriginal<typeof import("../../scripts/vault-sync")>()), getObject, putObject, listObjects, deleteObject };
});

import { BACKUP_BUCKET, LIVE_BUCKET } from "../../scripts/vault-sync";
import { verifySnapshot, bodyKeyFor, logBundleKeyFor, snapshotPrefix, type SnapshotManifest } from "../../scripts/vault-snapshot";

const STORE = "verify-store";
const ID = "2026-08-01T03-15-00Z";
const enc = (s: string) => new TextEncoder().encode(s);
const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const putLive = (key: string, text: string) => r2.set(`${LIVE_BUCKET}::${key}`, enc(text));
const putBackup = (key: string, body: Uint8Array) => r2.set(`${BACKUP_BUCKET}::${key}`, body);

/** One vault object and one log entry, live + backed up + claimed, all consistent. */
function seedConsistent(): SnapshotManifest {
  const vaultKey = `${STORE}/data-a.enc`;
  const logKey = `${STORE}/logs/refresh-finding/2026-08-01/a1-1.json`;
  const vaultBytes = enc("vault bytes");
  const logText = '{"event":"one"}';

  putLive(vaultKey, "vault bytes");
  putLive(logKey, logText);
  putBackup(bodyKeyFor(STORE, ID, vaultKey), vaultBytes);
  putBackup(logBundleKeyFor(STORE, ID), enc(JSON.stringify({ key: logKey, sha256: sha256Hex(enc(logText)), text: logText })));

  return {
    snapshotId: ID,
    createdAt: "2026-08-01T03:15:00.000Z",
    store: STORE,
    sourceBucket: LIVE_BUCKET,
    backupBucket: BACKUP_BUCKET,
    counts: { vault: 1, chat: 0, raw: 0, processed: 0, text: 0, logs: 1 },
    bytes: vaultBytes.length + logText.length,
    objects: [
      { key: vaultKey, size: vaultBytes.length, sha256: sha256Hex(vaultBytes), class: "vault" },
      { key: logKey, size: logText.length, sha256: sha256Hex(enc(logText)), class: "logs" },
    ],
    logBundleKey: logBundleKeyFor(STORE, ID),
    d1: { database: "health-identity-dev", sqlKey: "", jsonKey: "", sqlBytes: 0, rows: {} },
  };
}

beforeEach(() => r2.clear());

describe("verifySnapshot — a backup that really is what the manifest says", () => {
  it("passes when live, backup and manifest agree, and counts each class on both sides", async () => {
    const report = await verifySnapshot(seedConsistent());
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.sizeMismatch).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.counts.vault).toEqual({ live: 1, snapshot: 1 });
    expect(report.counts.logs).toEqual({ live: 1, snapshot: 1 });
  });
});

describe("verifySnapshot — the manifest is a claim, not evidence", () => {
  it("catches an object the manifest claims that the backup bucket does not hold", async () => {
    const manifest = seedConsistent();
    r2.delete(`${BACKUP_BUCKET}::${bodyKeyFor(STORE, ID, `${STORE}/data-a.enc`)}`);

    const report = await verifySnapshot(manifest);
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.includes("backup has no object"))).toBe(true);
  });

  it("catches a backed-up object whose size differs from the manifest — a truncated or partial PUT", async () => {
    const manifest = seedConsistent();
    putBackup(bodyKeyFor(STORE, ID, `${STORE}/data-a.enc`), enc("trunc"));

    const report = await verifySnapshot(manifest);
    expect(report.ok).toBe(false);
    expect(report.sizeMismatch.join(" ")).toMatch(/manifest \d+ ≠ backup \d+/);
  });

  it("catches a live object the snapshot never captured", async () => {
    const manifest = seedConsistent();
    putLive(`${STORE}/data-missed.enc`, "never captured");

    const report = await verifySnapshot(manifest);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain(`${STORE}/data-missed.enc`);
  });

  it("reports a live object that grew since the snapshot as a size mismatch, not a pass", async () => {
    const manifest = seedConsistent();
    putLive(`${STORE}/data-a.enc`, "vault bytes, plus a later save");

    const report = await verifySnapshot(manifest);
    expect(report.ok).toBe(false);
    expect(report.sizeMismatch.join(" ")).toMatch(/live \d+ ≠ snapshot \d+/);
  });

  it("reports an object that is no longer live as `extra`, which is informational and not a failure", async () => {
    const manifest = seedConsistent();
    r2.delete(`${LIVE_BUCKET}::${STORE}/data-a.enc`);
    // Deleting the live object leaves the backup and the manifest agreeing with each other.
    const report = await verifySnapshot(manifest);
    expect(report.extra).toContain(`${STORE}/data-a.enc`);
    expect(report.ok).toBe(true);
  });
});

describe("verifySnapshot — the log bundle is checked, not assumed", () => {
  it("catches the bundle being absent while entries are claimed", async () => {
    const manifest = seedConsistent();
    r2.delete(`${BACKUP_BUCKET}::${manifest.logBundleKey}`);

    const report = await verifySnapshot(manifest);
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.includes("log bundle absent"))).toBe(true);
  });

  it("catches an entry claimed in the manifest but absent from the bundle", async () => {
    const manifest = seedConsistent();
    putBackup(manifest.logBundleKey, enc(""));

    const report = await verifySnapshot(manifest);
    expect(report.ok).toBe(false);
    expect(report.missing.some((m) => m.includes("absent from the log bundle"))).toBe(true);
  });

  it("catches an entry whose bundled digest disagrees with the manifest", async () => {
    const manifest = seedConsistent();
    const logKey = manifest.objects.find((o) => o.class === "logs")!.key;
    putBackup(manifest.logBundleKey, enc(JSON.stringify({ key: logKey, sha256: "0".repeat(64), text: "whatever" })));

    const report = await verifySnapshot(manifest);
    expect(report.ok).toBe(false);
    expect(report.sizeMismatch.some((m) => m.includes("log bundle digest ≠ manifest digest"))).toBe(true);
  });

  it("does not look for log entries in the per-object backup — they live only in the bundle", async () => {
    const manifest = seedConsistent();
    const report = await verifySnapshot(manifest);
    expect(report.missing.join(" ")).not.toContain("logs/refresh-finding");
    expect(r2.has(`${BACKUP_BUCKET}::${snapshotPrefix(STORE, ID)}r2/${STORE}/logs/refresh-finding/2026-08-01/a1-1.json`)).toBe(false);
  });
});
