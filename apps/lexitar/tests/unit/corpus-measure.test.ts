import { describe, it, expect } from "vitest";
import { clientOf, groupByClient } from "../../scripts/corpus-measure";

// The measurement is per PATIENT, not per file: a tokens-per-page figure averaged across every
// namespace in the environment would describe a request nobody ever sends.
describe("grouping raw keys by namespace", () => {
  // Any store prefix: the namespace is read positionally, not against this worktree's environment.
  const key = (client: string, file: string) => `some-store/raw/${client}/${file}`;

  it("reads the namespace out of a raw key, not the filename", () => {
    expect(clientOf(key("alex", "2024-01-01-lab-cbc-ab12cd34.pdf"))).toBe("alex");
  });

  it("keeps one group per namespace, in the order the rows arrived", () => {
    const rows = [
      { r2_key: key("alex", "a.pdf"), pages: 3 },
      { r2_key: key("blair", "b.pdf"), pages: 5 },
      { r2_key: key("alex", "c.pdf"), pages: 7 },
    ];
    const grouped = groupByClient(rows);
    expect([...grouped.keys()]).toEqual(["alex", "blair"]);
    expect(grouped.get("alex")!.map((r) => r.pages)).toEqual([3, 7]);
  });
});
