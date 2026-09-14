import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readProcessed, sha8Of } from "../../scripts/processed-store";
import type { Vault, Roster, SourceRecord, ImagingExtraction, MarkerResult } from "../../src/lib/types";

// W13c: every committed source has a durable, inspectable PRE-FOLD processed artifact
// (records/private/{id}/processed/{sha8}.json). Reads the real committed files — so a source
// added without its processed artifact (forgot the ingest write / backfill) fails this.
describe("processed-store (records/private/{id}/processed)", () => {
  it("sha8Of takes the first 8 hex of the sha256", () => {
    expect(sha8Of("597cd4e77b75c4790155050c13ae182de03aeedc")).toBe("597cd4e7");
  });

  // G1 made the client id opaque, so the directory can no longer be spelled out. Walking the roster
  // is the derived form of the same assertion — and covers every client rather than one.
  it("every committed source has a pre-fold processed artifact of the matching kind/shape", async () => {
    const roster = JSON.parse(await readFile(resolve("records/private/roster.json"), "utf8")) as Roster;
    const ids = Object.keys(roster.clients);
    expect(ids.length).toBeGreaterThan(0);
    const sources: [string, SourceRecord][] = [];
    for (const id of ids) {
      const vault = JSON.parse(await readFile(resolve(`records/private/${id}/vault.json`), "utf8")) as Vault;
      for (const c of Object.values(vault.clients)) for (const s of c.sources ?? []) sources.push([id, s]);
    }
    expect(sources.length).toBeGreaterThan(0);
    for (const [id, s] of sources) {
      const art = await readProcessed(id, sha8Of(s.sha256));
      expect(art, `missing processed artifact for ${sha8Of(s.sha256)} — run \`npm run processed:backfill\``).not.toBeNull();
      expect(art!.kind).toBe(s.kind);
      expect(art!.sourceFile).toBe(s.file);
      if (s.kind === "imaging") {
        const d = art!.data as ImagingExtraction;
        expect(typeof d.studyType).toBe("string");
        expect(Array.isArray(d.markers)).toBe(true);
      } else {
        const d = art!.data as { rows: MarkerResult[] };
        expect(d.rows.length).toBeGreaterThan(0);
      }
    }
  });
});
