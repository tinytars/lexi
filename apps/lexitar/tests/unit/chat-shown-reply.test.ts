import { describe, it, expect } from "vitest";
import { shownReply, type Turn } from "../../src/lib/chat-threads";

const lexi: Turn = { role: "assistant", text: "• LDL 142 mg/dL, up from 118." };
const kodi: Turn = { ...lexi, adapted: { persona: "kodi", text: "Okay so your LDL went from 118 to 142 mg/dL." } };

describe("shownReply", () => {
  it("shows Lexi's own answer when nothing was adapted", () => {
    expect(shownReply(lexi, false)).toEqual({ persona: "lexi", text: lexi.text });
  });
  it("shows the adapted rendering, attributed to its persona", () => {
    expect(shownReply(kodi, false)).toEqual({ persona: "kodi", text: kodi.adapted!.text });
  });
  it("shows Lexi's original on request", () => {
    expect(shownReply(kodi, true)).toEqual({ persona: "lexi", text: lexi.text });
  });
});
