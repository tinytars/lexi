import { describe, it, expect, afterEach } from "vitest";
import { resolveMode, MODELS, DEFAULT_MODE } from "../../scripts/inference-config";

const orig = process.env.INFERENCE_MODE;
afterEach(() => {
  if (orig === undefined) delete process.env.INFERENCE_MODE;
  else process.env.INFERENCE_MODE = orig;
});

describe("resolveMode", () => {
  it("honors an explicit flag", () => {
    expect(resolveMode("dev")).toBe("dev");
    expect(resolveMode("prod")).toBe("prod");
  });

  it("is case-insensitive", () => {
    expect(resolveMode("DEV")).toBe("dev");
    expect(resolveMode("Prod")).toBe("prod");
  });

  it("flag beats env", () => {
    process.env.INFERENCE_MODE = "prod";
    expect(resolveMode("dev")).toBe("dev");
  });

  it("falls back to env then default", () => {
    process.env.INFERENCE_MODE = "dev";
    expect(resolveMode()).toBe("dev");
    delete process.env.INFERENCE_MODE;
    expect(resolveMode()).toBe(DEFAULT_MODE);
  });

  it("rejects an unknown mode", () => {
    expect(() => resolveMode("staging")).toThrow(/invalid inference mode/);
  });
});

describe("MODELS", () => {
  it("maps both modes to a finding + ranges + report model", () => {
    for (const mode of ["dev", "prod"] as const) {
      expect(typeof MODELS[mode].finding).toBe("string");
      expect(typeof MODELS[mode].ranges).toBe("string");
      expect(typeof MODELS[mode].report).toBe("string");
      expect(MODELS[mode].finding.length).toBeGreaterThan(0);
    }
  });

  it("uses Opus for prod and a cheaper model for dev", () => {
    expect(MODELS.prod.finding).toContain("opus");
    expect(MODELS.dev.finding).not.toContain("opus");
  });
});
