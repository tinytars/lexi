import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { isMain } from "../../scripts/is-main";

describe("isMain", () => {
  it("is false for a module imported by another entry point", () => {
    expect(isMain(import.meta.url)).toBe(false);
  });

  it("is true for the module the process was started with", () => {
    expect(isMain(pathToFileURL(process.argv[1]).href)).toBe(true);
  });
});
