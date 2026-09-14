import { describe, it, expect } from "vitest";
import { EXTRACT_MODEL } from "../../src/lib/extract-config";
import { MODELS } from "../../scripts/inference-config";

// W15/1 — web extraction must read a report with the SAME model the CLI uses for a
// prod report import, so a browser-uploaded and a CLI-imported report extract
// identically. This guards against the two ids silently drifting apart.
describe("extraction model parity", () => {
  it("EXTRACT_MODEL equals the CLI prod report model", () => {
    expect(EXTRACT_MODEL).toBe(MODELS.prod.report);
  });
});
