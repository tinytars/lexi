// W52 — the parts of the backup path that must be right before any bytes move: which live keys
// count as which class (an unrecognised shape must NOT be silently skipped), the snapshot id
// round-trip the retention sweep depends on, and the retention selection itself.

import { describe, it, expect } from "vitest";
import { classifyKey, mapPool } from "../../scripts/vault-sync";
import { snapshotIdFor, parseSnapshotId, idsToPrune } from "../../scripts/vault-snapshot";

describe("classifyKey", () => {
  it("classifies every key class storeKey() writes", () => {
    expect(classifyKey("dev", "dev/data-pablo.enc")).toBe("vault");
    expect(classifyKey("dev", "dev/data-8dafade9-9f33-426d-bb35-1f63ae168212.enc")).toBe("vault");
    expect(classifyKey("dev", "dev/chat-liz.enc")).toBe("chat");
    expect(classifyKey("dev", "dev/raw/liz/2025November17-imaging-37fe2b1b.pdf")).toBe("raw");
    expect(classifyKey("dev", "dev/processed/pablo/0851c334.json")).toBe("processed");
    expect(classifyKey("dev", "dev/logs/refresh-finding/2026-07-15/a1b92036-1.json")).toBe("logs");
  });

  it("returns null for a key shape it has not been taught — the snapshot turns that into a hard failure", () => {
    expect(classifyKey("dev", "dev/something-new/x.json")).toBeNull();
    expect(classifyKey("dev", "dev/data-pablo.txt")).toBeNull();
    expect(classifyKey("dev", "dev/raw/")).toBeNull();
  });

  it("refuses keys outside the store prefix, so one deploy's snapshot can never absorb another's", () => {
    expect(classifyKey("dev", "prod/data-pablo.enc")).toBeNull();
    expect(classifyKey("dev", "data-nope.enc")).toBeNull();
  });

  it("does not treat a nested key as a top-level vault blob", () => {
    expect(classifyKey("dev", "dev/raw/liz/data-x.enc")).toBe("raw");
  });
});

describe("snapshot ids", () => {
  it("are colon-free (R2-key-safe) and round-trip back to the instant", () => {
    const at = new Date("2026-08-09T09:53:44.512Z");
    const id = snapshotIdFor(at);
    expect(id).toBe("2026-08-09T09-53-44Z");
    expect(parseSnapshotId(id)?.toISOString()).toBe("2026-08-09T09:53:44.000Z");
  });

  it("sort lexicographically in time order", () => {
    const ids = ["2026-08-09T09-53-44Z", "2026-08-08T23-00-00Z", "2026-08-09T03-15-00Z"];
    expect([...ids].sort()).toEqual([
      "2026-08-08T23-00-00Z",
      "2026-08-09T03-15-00Z",
      "2026-08-09T09-53-44Z",
    ]);
  });

  it("rejects anything that is not a snapshot id, so the sweep never deletes an unrelated prefix", () => {
    expect(parseSnapshotId("latest")).toBeNull();
    expect(parseSnapshotId("2026-08-09")).toBeNull();
    expect(parseSnapshotId("2026-13-45T99-99-99Z")).toBeNull();
  });
});

describe("idsToPrune", () => {
  const ids = Array.from({ length: 5 }, (_, i) => `2026-08-0${i + 1}T03-15-00Z`);

  it("drops the oldest and keeps the newest N", () => {
    expect(idsToPrune(ids, 2)).toEqual(["2026-08-01T03-15-00Z", "2026-08-02T03-15-00Z", "2026-08-03T03-15-00Z"]);
  });

  it("keeps everything while under the window", () => {
    expect(idsToPrune(ids, 5)).toEqual([]);
    expect(idsToPrune(ids, 30)).toEqual([]);
  });

  it("never prunes the newest snapshot", () => {
    expect(idsToPrune(ids, 1)).not.toContain(ids[4]);
  });

  it("sorts before slicing, so listing order cannot cost you the newest backup", () => {
    expect(idsToPrune([...ids].reverse(), 1)).toEqual(ids.slice(0, 4));
  });
});

describe("mapPool", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapPool([30, 10, 20, 0], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 0]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});
