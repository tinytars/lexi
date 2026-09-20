import { describe, it, expect } from "vitest";
import { promotionBlockers, type Soak } from "../../scripts/promotion-gate";

const HOUR = 3_600_000;
const now = Date.parse("2026-09-20T12:00:00Z");
const range = ["aaaaaaa111", "bbbbbbb222"];
const soak = (over: Partial<Soak>): Soak => ({ range, tipTime: now - 25 * HOUR, now, ciGreen: true, reports: [], canaryAt: now - HOUR, ...over });
const report = (sha: string) => `- Fingerprint: 1234abcd\n- Build: tinytars/lexi@${sha}\n`;

describe("promotionBlockers", () => {
  it("promotes a quiet, green dev tip that has soaked a day", () => {
    expect(promotionBlockers(soak({}))).toEqual([]);
  });

  it("has nothing to promote when dev adds no commits", () => {
    expect(promotionBlockers(soak({ range: [] }))).toEqual(["dev has nothing that main lacks"]);
  });

  it("waits out the soak", () => {
    expect(promotionBlockers(soak({ tipTime: now - 23 * HOUR }))).toEqual(["dev tip is 23h old; soak is 24h"]);
  });

  it("requires CI green on the dev tip", () => {
    expect(promotionBlockers(soak({ ciGreen: false }))).toEqual(["CI is not green on the dev tip"]);
  });

  it("blocks on an error report from a build in the range, matched by short or full SHA", () => {
    expect(promotionBlockers(soak({ reports: [report("bbbbbbb")] }))).toEqual(["error reported from build bbbbbbb, which is in the range"]);
    expect(promotionBlockers(soak({ reports: [report("aaaaaaa111")] }))).toEqual(["error reported from build aaaaaaa111, which is in the range"]);
  });

  it("ignores reports from builds outside the range, and unknown builds", () => {
    expect(promotionBlockers(soak({ reports: [report("ccccccc333"), "- Build: unknown\n"] }))).toEqual([]);
  });

  // The whole point of the canary. Before it, `reports: []` because nothing broke and `reports: []`
  // because the sink is dead were the same value, and this gate promoted on the second one.
  it("refuses to read silence as health when the pipeline has never proved itself alive", () => {
    expect(promotionBlockers(soak({ canaryAt: null }))).toEqual([
      "the error pipeline has never proved itself alive; a quiet soak is not evidence",
    ]);
  });

  it("refuses a soak whose evidence of a live pipeline is older than the soak's own quiet stretch", () => {
    expect(promotionBlockers(soak({ canaryAt: now - 9 * HOUR }))).toEqual([
      "the error pipeline last proved itself alive 9h ago; a quiet soak is not evidence",
    ]);
  });

  it("still promotes a quiet soak once the pipeline is proven alive", () => {
    expect(promotionBlockers(soak({ canaryAt: now - 7 * HOUR }))).toEqual([]);
  });
});
