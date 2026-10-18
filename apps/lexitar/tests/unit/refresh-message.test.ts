import { describe, it, expect } from "vitest";
import { buildRefreshMessage } from "../../src/lib/refresh-message";
import type { LeafFailure } from "../../src/lib/finding-refresh";

function failure(label: string): LeafFailure {
  return { node: label, label, message: "boom" };
}

describe("buildRefreshMessage", () => {
  it("returns null when there are no failures and no invariants", () => {
    expect(buildRefreshMessage([], [])).toBeNull();
  });

  it("reports a single failure, singular section wording", () => {
    const msg = buildRefreshMessage([failure("Diet")], []);
    expect(msg).toBe(
      "Finished, but 1 section could not be regenerated: Diet — the previous version is still shown, marked out of date. Use ⋮ → Translate on each to retry.",
    );
  });

  it("reports multiple failures, plural section wording, joined labels", () => {
    const msg = buildRefreshMessage([failure("Diet"), failure("Sleep")], []);
    expect(msg).toBe(
      "Finished, but 2 sections could not be regenerated: Diet, Sleep — the previous version is still shown, marked out of date. Use ⋮ → Translate on each to retry.",
    );
  });

  it("reports a single invariant, singular wording, no +N more", () => {
    const msg = buildRefreshMessage([], ["stale treatmentGroups"]);
    expect(msg).toBe("Finished, but the assembled Finding has 1 inconsistency: stale treatmentGroups");
  });

  it("reports multiple invariants, plural wording, +N more counting only the rest", () => {
    const msg = buildRefreshMessage([], ["first issue", "second issue", "third issue"]);
    expect(msg).toBe("Finished, but the assembled Finding has 3 inconsistencies: first issue (+2 more)");
  });

  it("reports both failures and invariants together, joined with ' Also, ' — never else-if", () => {
    const msg = buildRefreshMessage([failure("Diet")], ["stale treatmentGroups"]);
    expect(msg).toBe(
      "Finished, but 1 section could not be regenerated: Diet — the previous version is still shown, marked out of date. Use ⋮ → Translate on each to retry. Also, the assembled Finding has 1 inconsistency: stale treatmentGroups",
    );
  });
});
