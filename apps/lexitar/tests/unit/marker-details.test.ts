// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "../support/mount";
import MarkerDetails from "../../src/lib/MarkerDetails.svelte";
import type { Client, MarkerResult } from "../../src/lib/types";

const reading = (date: string, value: number): MarkerResult =>
  ({ marker: "Glucose", group: "Metabolic Health", source: "Blood", date, value, unit: "mg/dL" }) as MarkerResult;

describe("MarkerDetails values table", () => {
  it("lists two readings taken on the same day", () => {
    const rows = [reading("2026-01-01", 90), reading("2026-01-01", 110), reading("2025-06-01", 95)];
    const client = { displayName: "P", dob: "1980-01-01", gender: "male", watchlist: [], results: rows } as unknown as Client;
    const el = render(MarkerDetails, { name: "Glucose", rows, client });
    expect(el.querySelectorAll(".mc-values-table tr")).toHaveLength(3);
  });
});
