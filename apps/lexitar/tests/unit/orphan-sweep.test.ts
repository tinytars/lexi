import { describe, it, expect } from "vitest";
import { orphanedNamespaces, eligibleForDeletion, graceDays } from "../../scripts/orphan-sweep";
import { claimProofs } from "../../src/lib/orphan-claim";
import type { Client } from "../../src/lib/types";

// W76 — which namespaces the sweep may ever touch, and when. Deletion is irreversible, so the
// selection is pinned here against fixed fixtures rather than trusted to the live run.

const obj = (key: string, size = 10) => ({ key, size, etag: "e" });

describe("orphanedNamespaces", () => {
  const objects = [
    obj("prod/raw/alex/a.pdf"),
    obj("prod/text/alex/a.txt"),
    obj("prod/chat-alex.enc"),
    obj("prod/raw/sam/b.pdf"),
    obj("prod/chat-sam.enc"),
    obj("prod/raw/kim/c.pdf"),
    obj("prod/chat-lee.enc"),
  ];

  it("groups every unattributed object under its namespace, across all three key shapes", () => {
    const orphans = orphanedNamespaces(objects, []);
    expect([...orphans.keys()].sort()).toEqual(["alex", "kim", "lee", "sam"]);
    expect(orphans.get("alex")!.map((o) => o.key)).toEqual(["prod/raw/alex/a.pdf", "prod/text/alex/a.txt", "prod/chat-alex.enc"]);
  });

  it("treats one owned key as owning the namespace, as the routes do", () => {
    const orphans = orphanedNamespaces(objects, ["prod/chat-alex.enc", "prod/raw/kim/c.pdf"]);
    expect([...orphans.keys()].sort()).toEqual(["lee", "sam"]);
  });

  it("ignores keys outside the client namespaces", () => {
    expect(orphanedNamespaces([obj("prod/data-x.enc"), obj("prod/processed/x/1.json")], []).size).toBe(0);
  });
});

describe("eligibleForDeletion", () => {
  const now = new Date("2026-12-31T00:00:00Z");
  const seen = new Map([
    ["old", "2026-09-01T00:00:00Z"],
    ["edge", "2026-10-02T00:00:00Z"],
    ["new", "2026-12-01T00:00:00Z"],
  ]);

  it("selects only orphans first seen at least the grace period ago", () => {
    expect(eligibleForDeletion(["old", "edge", "new"], seen, 90, now)).toEqual(["old", "edge"]);
  });

  it("selects every recorded orphan at grace 0, which the operator asks for explicitly", () => {
    expect(eligibleForDeletion(["old", "edge", "new", "unrecorded"], seen, 0, now)).toEqual(["old", "edge", "new"]);
  });

  it("defaults to 90 days and accepts 0, never a negative or fractional grace", () => {
    expect(graceDays(["node", "sweep"])).toBe(90);
    expect(graceDays(["node", "sweep", "--grace-days", "0"])).toBe(0);
    expect(() => graceDays(["node", "sweep", "--grace-days", "-1"])).toThrow();
    expect(() => graceDays(["node", "sweep", "--grace-days", "1.5"])).toThrow();
  });

  it("never selects an orphan with no recorded first sighting", () => {
    expect(eligibleForDeletion(["unrecorded"], seen, 1, now)).toEqual([]);
  });
});

describe("claimProofs", () => {
  const rec = (file: string, n: number) => ({ file, sha256: String(n).repeat(64).slice(0, 64) });

  it("sends the raw file name and full hash of the newest five stored originals", () => {
    const client = {
      sources: [1, 2, 3, 4].map((n) => rec(`raw/r${n}.pdf`, n)),
      pendingUploads: [5, 6].map((n) => rec(`raw/p${n}.pdf`, n)),
    } as unknown as Client;
    expect(claimProofs(client).map((p) => p.file)).toEqual(["r2.pdf", "r3.pdf", "r4.pdf", "p5.pdf", "p6.pdf"]);
    expect(claimProofs(client)[0].sha256).toHaveLength(64);
  });

  it("has nothing to prove for a client with no stored originals", () => {
    expect(claimProofs({} as Client)).toEqual([]);
  });
});
