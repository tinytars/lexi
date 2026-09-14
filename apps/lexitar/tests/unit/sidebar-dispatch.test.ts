import { describe, it, expect } from "vitest";
import { decideSidebarAction } from "../../src/lib/sidebar-dispatch";
import type { Tab } from "../../src/lib/nav";

const SECTION_TAB: Record<string, Tab> = { markers: "labs", healthReports: "labs", vitals: "labs" };

describe("decideSidebarAction", () => {
  it("chat + new: navigates to the chat tab and starts a new thread", () => {
    const d = decideSidebarAction("chat", "new", SECTION_TAB);
    expect(d.navigate).toEqual({ tab: "chat", section: undefined });
    expect(d.effect).toBe("startNewChatThread");
  });

  it("chat + add: navigates to the chat tab but stashes a pending action instead of starting a thread", () => {
    const d = decideSidebarAction("chat", "add", SECTION_TAB);
    expect(d.navigate).toEqual({ tab: "chat", section: undefined });
    expect(d.effect).toBe("setPending");
    if (d.effect === "setPending") expect(d.pending).toEqual({ section: "chat", verb: "add" });
  });

  it("markers: opens the Import modal regardless of verb, resolving the owning tab", () => {
    const d = decideSidebarAction("markers", "add", SECTION_TAB);
    expect(d.navigate).toEqual({ tab: "labs", section: "markers" });
    expect(d.effect).toBe("openImport");
  });

  it("healthReports: opens the Import modal too", () => {
    const d = decideSidebarAction("healthReports", "new", SECTION_TAB);
    expect(d.effect).toBe("openImport");
  });

  it("any other section: stashes a pending action for the freshly-mounted leaf to consume", () => {
    const d = decideSidebarAction("vitals", "add", SECTION_TAB);
    expect(d.navigate).toEqual({ tab: "labs", section: "vitals" });
    expect(d.effect).toBe("setPending");
    if (d.effect === "setPending") expect(d.pending).toEqual({ section: "vitals", verb: "add" });
  });
});
