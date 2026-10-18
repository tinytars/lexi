import { describe, it, expect } from "vitest";

// frame is reusable by any organization: it ships the shape of a brand, never an entity's values.
const ENTITY = /LexiTar|Tiny ?Tars|Foundation|tinytars\.foundation/i;
const shipped = import.meta.glob<string>(["./*.{ts,svelte,css}", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("entity neutrality", () => {
  it("covers the shipped sources", () => expect(Object.keys(shipped).length).toBeGreaterThan(40));

  it.each(Object.entries(shipped))("%s names no specific organization or product", (_file, text) => {
    expect(text.replaceAll("@tinytars/", "")).not.toMatch(ENTITY);
  });
});
