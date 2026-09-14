import { describe, it, expect } from "vitest";
import { storeKey } from "../../functions/_lib/store";

// W13d: every R2 key is namespaced by env.STORE_PREFIX so concurrent branch deploys never
// collide. An unset/empty prefix MUST throw — defaulting to "" would silently merge keys.
describe("storeKey", () => {
  it("prefixes the parts with the store and joins with /", () => {
    expect(storeKey({ STORE_PREFIX: "dev" }, "data-pablo.enc")).toBe("dev/data-pablo.enc");
    expect(storeKey({ STORE_PREFIX: "dev" }, "raw", "pablo", "x.pdf")).toBe("dev/raw/pablo/x.pdf");
    expect(storeKey({ STORE_PREFIX: "prod" }, "processed", "liz", "abc.json")).toBe("prod/processed/liz/abc.json");
  });
  it("throws on an unset prefix", () => {
    expect(() => storeKey({}, "data-pablo.enc")).toThrow(/STORE_PREFIX is unset/);
  });
  it("throws on an empty / whitespace prefix", () => {
    expect(() => storeKey({ STORE_PREFIX: "" }, "x")).toThrow(/STORE_PREFIX is unset/);
    expect(() => storeKey({ STORE_PREFIX: "   " }, "x")).toThrow(/STORE_PREFIX is unset/);
  });
});
