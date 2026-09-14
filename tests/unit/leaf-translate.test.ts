// W76 — the Translate button four leaf editors share, which had no test at all.
//
// Its failure modes are both invisible to a passing e2e: a spinner that never stops (`translatingId`
// left set, so the row stays disabled and the patient's only recourse is a reload), and a raw JSON
// body rendered where a sentence belongs — which ai-error.ts's own comment says must never reach a
// patient. Four editors share the module, so either bug is four bugs.

import { describe, it, expect, vi } from "vitest";
import { createLeafTranslate } from "../../src/lib/leaf-translate.svelte";
import { AiError } from "../../src/lib/ai-error";

type Result = { status: "filled" | "empty" | "skipped" | "failed"; error?: string };

function harness(trigger?: (key: string, targets?: string[], force?: boolean) => Promise<Result>) {
  const calls: { key: string; targets?: string[]; force?: boolean }[] = [];
  const fn = trigger
    ? vi.fn(async (key: string, targets?: string[], force?: boolean) => {
        calls.push({ key, targets, force });
        return trigger(key, targets, force);
      })
    : undefined;
  return { t: createLeafTranslate(() => fn), calls };
}

const ok = async (): Promise<Result> => ({ status: "filled" });

describe("createLeafTranslate", () => {
  it("forces the regen, bypassing the staleness gate the click cannot see", async () => {
    const { t, calls } = harness(ok);
    await t.run("note-3", "notes", ["Sleep"]);
    expect(calls).toEqual([{ key: "notes", targets: ["Sleep"], force: true }]);
  });

  it("marks the row pending while the call is in flight and clears it after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { t } = harness(async () => {
      await gate;
      return { status: "filled" };
    });
    const running = t.run("note-3", "notes", ["Sleep"]);
    expect(t.translatingId).toBe("note-3");
    release();
    await running;
    expect(t.translatingId).toBeNull();
  });

  it("clears the pending id even when the call throws", async () => {
    const { t } = harness(async () => {
      throw new Error("boom");
    });
    await t.run("note-3", "notes", []);
    expect(t.translatingId).toBeNull();
  });

  it("clears the pending id when no trigger is wired at all", async () => {
    const { t } = harness();
    await t.run("note-3", "notes", []);
    expect(t.translatingId).toBeNull();
    expect(t.translateError).toBeNull();
  });

  it("reports the server's own sentence on a failed status", async () => {
    const { t } = harness(async () => ({ status: "failed", error: "the source row is empty" }));
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBe("the source row is empty");
  });

  it("still says something when a failure arrives with no message", async () => {
    const { t } = harness(async () => ({ status: "failed" }));
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBe("Couldn't translate.");
  });

  it("distinguishes nothing-to-do from a failure", async () => {
    const { t } = harness(async () => ({ status: "empty" }));
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBe("Nothing to translate yet.");
  });

  it("treats a skipped regen as success, not an error", async () => {
    const { t } = harness(async () => ({ status: "skipped" }));
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBeNull();
  });

  it("renders the classified sentence for a coded failure, not the thrown message", async () => {
    const { t } = harness(async () => {
      throw new AiError("HTTP 402", { errorCode: "insufficient_credit", status: 402 });
    });
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBe("AI is temporarily unavailable: the account is out of credits.");
    expect(t.translateError).not.toContain("402");
  });

  it("never shows a patient a leaked JSON body", async () => {
    const { t } = harness(async () => {
      throw new Error('{"error":"upstream exploded","errorCode":"anthropic_error"}');
    });
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBe("Couldn't translate — try again in a moment.");
  });

  it("clears the previous error when a retry starts, so a stale message never outlives it", async () => {
    let fail = true;
    const { t } = harness(async () => (fail ? { status: "failed", error: "nope" } : { status: "filled" }));
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBe("nope");
    fail = false;
    await t.run("note-3", "notes", []);
    expect(t.translateError).toBeNull();
  });
});
