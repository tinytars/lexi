import { describe, it, expect } from "vitest";
import { parseHash, toHash, type Permalink } from "../../src/lib/permalink";

describe("parseHash", () => {
  it("parses a flat client + section (M82 flat grammar)", () => {
    expect(parseHash("#pablo/study")).toEqual({ client: "pablo", tab: "ai", section: "study", anchor: undefined });
  });
  it("tolerates a missing leading '#'", () => {
    expect(parseHash("pablo/study")?.section).toBe("study");
    expect(parseHash("chat")?.tab).toBe("chat");
  });
  it("parses client + section + anchor", () => {
    expect(parseHash("#pablo/healthReports/report-abc123def456")).toEqual({
      client: "pablo", tab: "labs", section: "healthReports", anchor: "report-abc123def456",
    });
  });
  it("parses chat with a thread id", () => {
    expect(parseHash("#pablo/chat/t2")).toEqual({ client: "pablo", tab: "chat", section: "t2", anchor: undefined });
  });
  it("returns null when no segment is a section key, chat, or a legacy tab id", () => {
    expect(parseHash("#pablo/nonsense")).toBeNull();
    expect(parseHash("#")).toBeNull();
    expect(parseHash("")).toBeNull();
  });
  it("decodes percent-encoded segments", () => {
    expect(parseHash("#li%2Fz/chat")?.client).toBe("li/z");
  });

  describe("legacy back-compat (pre-M82 #<client>/<tab>/<section> links)", () => {
    it.each([
      ["labs", "markers"],
      ["doctor", "treatment"],
      ["appointment", "notes"],
      ["ai", "study"],
    ])("drops a stale '%s' tab segment ahead of a real '%s' section", (tab, section) => {
      expect(parseHash(`#pablo/${tab}/${section}`)).toMatchObject({ client: "pablo", section });
    });
    it("legacy chat/<threadId> is unchanged (chat never had a tab-vs-section ambiguity)", () => {
      expect(parseHash("#pablo/chat/t9")).toMatchObject({ client: "pablo", tab: "chat", section: "t9" });
    });
    it.each([
      ["labs", "markers"],
      ["doctor", "treatment"],
      ["appointment", "notes"],
      ["ai", "analysis"],
    ])("maps a bare legacy '%s' tab to its LEGACY_TAB_DEFAULT section '%s'", (tab, section) => {
      expect(parseHash(`#pablo/${tab}`)).toMatchObject({ client: "pablo", tab, section });
    });
    it("maps a bare pre-W38 tab-only hash (no client) the same way", () => {
      expect(parseHash("#doctor")).toEqual({ client: undefined, tab: "doctor", section: "treatment", anchor: undefined });
    });
    it("a bare chat segment has no default thread (chat's own section slot stays empty)", () => {
      expect(parseHash("#pablo/chat")).toEqual({ client: "pablo", tab: "chat", section: undefined, anchor: undefined });
    });
  });
});

describe("toHash", () => {
  it("emits a bare tab when there is no client", () => {
    expect(toHash({ tab: "doctor" })).toBe("#doctor");
  });
  it("drops section without a client (deeper links are patient-scoped)", () => {
    expect(toHash({ tab: "doctor", section: "treatment" })).toBe("#doctor");
  });
  it("emits client + section, no tab segment", () => {
    expect(toHash({ client: "pablo", tab: "ai", section: "study" })).toBe("#pablo/study");
  });
  it("emits client only when there is no section (flat grammar drops the tab)", () => {
    expect(toHash({ client: "pablo", tab: "ai" })).toBe("#pablo");
  });
  it("emits the full path", () => {
    expect(toHash({ client: "pablo", tab: "labs", section: "healthReports", anchor: "report-abc" }))
      .toBe("#pablo/healthReports/report-abc");
  });
  it("omits a dangling anchor when there is no section", () => {
    expect(toHash({ client: "pablo", tab: "doctor", anchor: "report-abc" })).toBe("#pablo");
  });
  it("keeps chat's literal 'chat' segment", () => {
    expect(toHash({ client: "pablo", tab: "chat", section: "t2" })).toBe("#pablo/chat/t2");
  });
  it("encodes odd segments", () => {
    expect(toHash({ client: "li/z", tab: "chat" })).toBe("#li%2Fz/chat");
  });
});

describe("round-trip", () => {
  const cases: Permalink[] = [
    { tab: "doctor", section: "treatment" },
    { client: "pablo", tab: "ai", section: "study" },
    { client: "pablo", tab: "labs", section: "healthReports", anchor: "report-abc123" },
    { client: "liz", tab: "chat", section: "conv", anchor: "t2-turn-3" },
  ];
  for (const pl of cases) {
    it(`toHash→parseHash preserves ${JSON.stringify(pl)}`, () => {
      const parsed = parseHash(toHash(pl));
      // parseHash always fills the four keys; compare with undefined-normalised original.
      expect(parsed).toEqual({
        client: pl.client, tab: pl.tab, section: pl.section, anchor: pl.anchor,
      });
    });
  }
});
