import { describe, it, expect } from "vitest";
import { runMarkerTool, GET_MARKER_READINGS_TOOL } from "../../src/lib/chat-tools";
import type { Client, MarkerResult } from "../../src/lib/types";

function r(marker: string, date: string, value: number, unit = "mg/dL"): MarkerResult {
  return { marker, group: "Blood", source: "Blood", date, value, unit };
}

function client(): Client {
  return {
    displayName: "Pablo",
    dob: "1980-01-01",
    gender: "male",
    watchlist: [],
    results: [
      r("LDL-C", "2024-01-10", 130),
      r("LDL-C", "2025-06-01", 110),
      r("LDL-C", "2026-06-01", 98),
      r("Vitamin B12", "2025-10-04", 310, "pg/mL"),
    ],
  } as Client;
}

describe("get_marker_readings tool", () => {
  it("declares markers as required and takes optional from/to", () => {
    expect(GET_MARKER_READINGS_TOOL.name).toBe("get_marker_readings");
    expect(GET_MARKER_READINGS_TOOL.input_schema.required).toEqual(["markers"]);
  });

  it("returns the full series for a marker, oldest→newest, in the chosen unit system", () => {
    const [ldl] = runMarkerTool(client(), { markers: ["LDL-C"] }, "imperial");
    expect(ldl.marker).toBe("LDL-C");
    expect(ldl.rows).toEqual([
      { date: "2024-01-10", value: 130, unit: "mg/dL" },
      { date: "2025-06-01", value: 110, unit: "mg/dL" },
      { date: "2026-06-01", value: 98, unit: "mg/dL" },
    ]);
  });

  it("point-in-time lookup via a date range (regression: B12 on a specific date)", () => {
    const [b12] = runMarkerTool(client(), { markers: ["Vitamin B12"], from: "2025-10-04", to: "2025-10-04" });
    expect(b12.rows).toEqual([{ date: "2025-10-04", value: 310, unit: "pg/mL" }]);
  });

  it("filters by from/to inclusively", () => {
    const [ldl] = runMarkerTool(client(), { markers: ["LDL-C"], from: "2025-01-01" });
    expect(ldl.rows.map((x) => x.date)).toEqual(["2025-06-01", "2026-06-01"]);
  });

  it("matches marker names case-insensitively and returns the canonical name", () => {
    const [ldl] = runMarkerTool(client(), { markers: ["ldl-c"] });
    expect(ldl.marker).toBe("LDL-C");
    expect(ldl.rows).toHaveLength(3);
  });

  it("returns empty rows + a note for an unknown marker (model self-corrects from the catalog)", () => {
    const [x] = runMarkerTool(client(), { markers: ["Kryptonite"] });
    expect(x).toEqual({ marker: "Kryptonite", rows: [], note: expect.stringContaining("unknown") });
  });

  it("converts to SI when requested", () => {
    const [ldl] = runMarkerTool(client(), { markers: ["LDL-C"] }, "metric");
    expect(ldl.rows[0].unit).toBe("mmol/L");
    expect(ldl.rows[0].value).toBeCloseTo(130 / 38.67, 6);
  });

  it("batches multiple markers in one call", () => {
    const out = runMarkerTool(client(), { markers: ["LDL-C", "Vitamin B12"] });
    expect(out.map((o) => o.marker)).toEqual(["LDL-C", "Vitamin B12"]);
  });
});
