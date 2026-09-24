import { describe, it, expect } from "vitest";
import { parseHash } from "../../src/lib/permalink";

// ChatTab's composer paste handler feeds parseHash whatever follows the first "#" in the pasted
// text, so the input is arbitrary prose, not a permalink. A bare "%" in that prose is not a valid
// percent-escape, and decoding it must not take the handler down.
describe("parseHash with segments that are not valid percent-escapes", () => {
  it("returns null for pasted prose carrying a bare '%'", () => {
    expect(parseHash("#4 — tapered to 50% of the starting dose")).toBeNull();
  });

  it("still resolves a section when a sibling segment has a bare '%'", () => {
    expect(parseHash("#100%/study")).toMatchObject({ client: "100%", tab: "ai", section: "study" });
  });

  it("leaves an undecodable segment as written instead of throwing", () => {
    expect(parseHash("#chat/thread%zz")).toMatchObject({ tab: "chat", section: "thread%zz" });
  });

  it("keeps decoding well-formed escapes", () => {
    expect(parseHash("#li%2Fz/study")?.client).toBe("li/z");
  });
});
