import { describe, it, expect } from "vitest";
import { mergeInferredFields } from "../../src/lib/treatment-infer-merge";
import type { ProposedTreatment } from "@pablotech/akesi-pil/treatment-infer";

function result(overrides: Partial<ProposedTreatment> = {}): ProposedTreatment {
  return { name: "Metformin", kind: "drug", ...overrides };
}

describe("mergeInferredFields", () => {
  it("always sets name and kind", () => {
    const patch = mergeInferredFields(result({ name: "Vitamin D", kind: "supplement" }), "text", "");
    expect(patch.name).toBe("Vitamin D");
    expect(patch.kind).toBe("supplement");
  });

  it("omits description/maker/ingredients/links when absent", () => {
    const patch = mergeInferredFields(result(), "text", "");
    expect(patch).not.toHaveProperty("description");
    expect(patch).not.toHaveProperty("maker");
    expect(patch).not.toHaveProperty("ingredients");
    expect(patch).not.toHaveProperty("links");
  });

  it("sets description/maker/ingredients/links only when present/non-empty", () => {
    const patch = mergeInferredFields(
      result({
        description: "Blood sugar control",
        maker: "Acme",
        ingredients: [{ name: "metformin HCl" }],
        links: [{ label: "site", url: "https://example.com" }],
      }),
      "text",
      "",
    );
    expect(patch.description).toBe("Blood sugar control");
    expect(patch.maker).toBe("Acme");
    expect(patch.ingredients).toEqual([{ name: "metformin HCl" }]);
    expect(patch.links).toEqual([{ label: "site", url: "https://example.com" }]);
  });

  it("empty ingredients/links arrays are treated as absent", () => {
    const patch = mergeInferredFields(result({ ingredients: [], links: [] }), "text", "");
    expect(patch).not.toHaveProperty("ingredients");
    expect(patch).not.toHaveProperty("links");
  });

  it("administration present also locks doseUnit to the administration's unit", () => {
    const administration = { unit: "mg", unitsPerServing: 500, suggestedUnits: 1, suggestedFrequency: "day" as const };
    const patch = mergeInferredFields(result({ administration }), "text", "");
    expect(patch.administration).toBe(administration);
    expect(patch.doseUnit).toBe("mg");
  });

  it("no administration means no administration or doseUnit patch", () => {
    const patch = mergeInferredFields(result(), "text", "");
    expect(patch).not.toHaveProperty("administration");
    expect(patch).not.toHaveProperty("doseUnit");
  });

  it("photo source stamps extracted.via as photo and never sets rawCaptureText", () => {
    const patch = mergeInferredFields(result(), "photos", "");
    expect(patch.extracted?.via).toBe("photo");
    expect(patch).not.toHaveProperty("rawCaptureText");
  });

  it("text source stamps extracted.via as text and sets rawCaptureText to the trimmed input", () => {
    const patch = mergeInferredFields(result(), "text", "  pasted label text  ");
    expect(patch.extracted?.via).toBe("text");
    expect(patch.rawCaptureText).toBe("pasted label text");
  });

  it("extracted.at is a valid ISO timestamp", () => {
    const patch = mergeInferredFields(result(), "text", "");
    expect(patch.extracted?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
