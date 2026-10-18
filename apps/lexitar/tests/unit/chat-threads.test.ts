import { describe, it, expect } from "vitest";
import {
  newThread, titleFor, sortThreads, adoptThreads, buildReferenceTurn, seedNewThread, type Thread,
} from "../../src/lib/chat-threads";
import type { ResolvedReference } from "../../src/lib/reference-resolver";
import type { Permalink } from "../../src/lib/permalink";

describe("chat-threads", () => {
  it("newThread starts untitled, unpinned, empty, with an increasing seq", () => {
    const a = newThread();
    const b = newThread();
    expect(a.title).toBe("New chat");
    expect(a.pinned).toBe(false);
    expect(a.turns).toEqual([]);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.id).not.toBe(b.id);
  });

  it("titleFor derives the title from the first message while untitled", () => {
    const t = newThread();
    expect(titleFor(t, "what changed since my echo?")).toBe("what changed since my echo?");
  });

  it("titleFor truncates a long first message", () => {
    const t = newThread();
    const long = "a".repeat(80);
    const title = titleFor(t, long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(48);
  });

  it("titleFor leaves an already-named thread alone", () => {
    const t: Thread = { ...newThread(), title: "Echo follow-up" };
    expect(titleFor(t, "ignored")).toBe("Echo follow-up");
  });

  it("titleFor falls back to the default for an empty message", () => {
    const t = newThread();
    expect(titleFor(t, "   ")).toBe("New chat");
  });

  it("adoptThreads rebases the counter so a new thread outranks every hydrated one (no id/seq collision)", () => {
    const restored: Thread[] = [
      { id: "t7", title: "old", pinned: false, turns: [], seq: 7, lastActivityAt: 7 },
      { id: "t9", title: "newer", pinned: true, turns: [], seq: 9, lastActivityAt: 9 },
    ];
    const adopted = adoptThreads(restored);
    expect(adopted).toEqual(restored); // no duplicates: same threads, same order
    const fresh = newThread();
    expect(fresh.seq).toBeGreaterThan(9);
    expect(restored.some((t) => t.id === fresh.id)).toBe(false);
  });

  it("adoptThreads returns a fresh thread when the restored set is empty", () => {
    const adopted = adoptThreads([]);
    expect(adopted).toHaveLength(1);
    expect(adopted[0].turns).toEqual([]);
  });

  it("adoptThreads drops a duplicate id, keeping the last occurrence, and does not crash", () => {
    const stale: Thread = { id: "t69", title: "stale copy", pinned: false, turns: [], seq: 5, lastActivityAt: 5 };
    const fresh: Thread = { id: "t69", title: "current copy", pinned: false, turns: [], seq: 9, lastActivityAt: 9 };
    const other: Thread = { id: "t70", title: "unrelated", pinned: false, turns: [], seq: 6, lastActivityAt: 6 };
    const adopted = adoptThreads([stale, other, fresh]);
    const ids = adopted.map((t) => t.id);
    expect(ids).toEqual(["t69", "t70"]); // stale t69's slot kept, its value replaced by the later fresh t69
    expect(adopted.find((t) => t.id === "t69")?.title).toBe("current copy");
    const nextThread = newThread();
    expect(nextThread.seq).toBeGreaterThan(9); // counter rebased off the surviving (higher) seq
  });

  it("adoptThreads reads a turn saved under Kodi as Cody's, and shows Lexi's original for a persona no longer offered", () => {
    const answer = { role: "assistant" as const, text: "• LDL 142 mg/dL." };
    const saved = [
      { ...answer, adapted: { persona: "kodi", text: "Your LDL is 142 mg/dL." } },
      { ...answer, adapted: { persona: "hal", text: "I'm sorry, Dave." } },
    ] as unknown as Thread["turns"];
    const [adopted] = adoptThreads([{ id: "t3", title: "ldl", pinned: false, turns: saved, seq: 3, lastActivityAt: 3 }]);
    expect(adopted.turns).toEqual([{ ...answer, adapted: { persona: "cody", text: "Your LDL is 142 mg/dL." } }, answer]);
  });

  it("sortThreads puts pinned first, then most-recent-first by lastActivityAt", () => {
    const oldest = { ...newThread(), lastActivityAt: 1 };
    const middle = { ...newThread(), lastActivityAt: 2 };
    const newest = { ...newThread(), lastActivityAt: 3 };
    const ordered = sortThreads([oldest, middle, newest, { ...oldest, pinned: true }]);
    // The pinned (old) thread leads despite being the oldest.
    expect(ordered[0].pinned).toBe(true);
    expect(ordered[0].lastActivityAt).toBe(oldest.lastActivityAt);
    // Within the unpinned group, the most recently active comes first.
    const unpinned = ordered.filter((t) => !t.pinned);
    expect(unpinned[0].lastActivityAt).toBe(newest.lastActivityAt);
    expect(unpinned[unpinned.length - 1].lastActivityAt).toBe(oldest.lastActivityAt);
  });

  it("buildReferenceTurn warns when the reference is for a different patient", () => {
    const resolved: ResolvedReference = {
      kind: "wrong-patient",
      permalink: { tab: "markers" } as Permalink,
      preview: { title: "Wrong patient", tag: "Blocked" },
      context: null,
    };
    const turn = buildReferenceTurn(resolved);
    expect(turn.role).toBe("user");
    expect(turn.text).toBe("This link is for a different patient — switch patients first");
    expect(turn.reference).toEqual({ permalink: resolved.permalink, kind: resolved.kind, preview: resolved.preview });
  });

  it("buildReferenceTurn warns when the reference target could not be found", () => {
    const resolved: ResolvedReference = {
      kind: "unresolved",
      permalink: { tab: "labs" } as Permalink,
      preview: { title: "Link not found", tag: "Unresolved" },
      context: null,
    };
    const turn = buildReferenceTurn(resolved);
    expect(turn.text).toBe("This link's target could not be found");
    expect(turn.reference).toEqual({ permalink: resolved.permalink, kind: resolved.kind, preview: resolved.preview });
  });

  it("buildReferenceTurn renders a normal reference as 'Referenced: <title> (<tag>)'", () => {
    const resolved: ResolvedReference = {
      kind: "marker",
      permalink: { tab: "markers", anchor: "hdl" } as Permalink,
      preview: { title: "HDL", subtitle: "Latest 45 mg/dL", tag: "Marker" },
      context: null,
    };
    const turn = buildReferenceTurn(resolved);
    expect(turn.text).toBe("Referenced: HDL (Marker)");
    expect(turn.reference).toEqual({ permalink: resolved.permalink, kind: resolved.kind, preview: resolved.preview });
  });

  it("seedNewThread seeds a single reference turn and a title from the leaf preview", () => {
    const resolved: ResolvedReference = {
      kind: "marker",
      permalink: { tab: "markers", anchor: "hdl" } as Permalink,
      preview: { title: "HDL", subtitle: "Latest 45 mg/dL", tag: "Marker" },
      context: null,
    };
    const thread = seedNewThread(resolved);
    expect(thread.turns.length).toBe(1);
    expect(thread.turns[0].reference).toEqual({ permalink: resolved.permalink, kind: resolved.kind, preview: resolved.preview });
    expect(thread.title).toBe(titleFor(newThread(), "HDL — Latest 45 mg/dL"));
  });

  it("seedNewThread truncates a long leaf preview into the thread title", () => {
    const resolved: ResolvedReference = {
      kind: "report",
      permalink: { tab: "labs", anchor: "report-1" } as Permalink,
      preview: {
        title: "A very long report title that goes on and on and on",
        subtitle: "with an equally long subtitle appended after it",
        tag: "Lab",
      },
      context: null,
    };
    const thread = seedNewThread(resolved);
    const previewText = `${resolved.preview.title} — ${resolved.preview.subtitle}`;
    expect(thread.title).toBe(titleFor(newThread(), previewText));
    expect(thread.title.endsWith("…")).toBe(true);
    expect(thread.title.length).toBeLessThanOrEqual(48);
  });
});
