// @vitest-environment jsdom
import { it, expect } from "vitest";
import { flushSync } from "svelte";
import { render } from "../support/mount";
import HealthReports from "../../src/lib/HealthReports.svelte";
import type { Client, SourceRecord } from "../../src/lib/types";

function client(): Client {
  return {
    displayName: "A", dob: "1980-01-01", gender: "male", watchlist: [], results: [],
    sources: [{ id: "s1", sha256: "s1", kind: "imaging", studyType: "Echo", studyDate: "2026-01-31", file: "s1.pdf", originalName: "s1.pdf", importedAt: "2026-02-01" } as SourceRecord],
    factors: {
      diseases: [
        { id: "a", date: "2026-01-31", diagnostic: "Aortic sclerosis", sourceId: "s1" },
        { id: "b", date: "2026-01-31", diagnostic: "Mitral regurgitation", sourceId: "s1", pinned: true },
      ],
    },
  } as Client;
}

// The modal lists diagnoses pinned-first while the vault stores them in insertion order; the save
// used to patch by position, so editing the top (pinned) row rewrote the other diagnosis.
it("an edit to a pinned diagnosis lands on that diagnosis, not the one at its vault position", () => {
  const saves: Client[] = [];
  const el = render(HealthReports, { client: client(), onSave: (c: Client) => saves.push(c) });

  el.querySelector<HTMLButtonElement>(".leaf-card-head .leaf-menu-trigger")!.click();
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((b) => b.textContent?.includes("Edit"))!.click();
  flushSync();

  const top = document.querySelector(".cr-edit-dx")!.querySelector<HTMLInputElement>("input[type=text]")!;
  expect(top.value).toBe("Mitral regurgitation");
  top.value = "Mitral regurgitation, moderate";
  top.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Save")!.click();
  flushSync();

  const byId = Object.fromEntries(saves.at(-1)!.factors!.diseases!.map((d) => [d.id, d.diagnostic]));
  expect(byId).toEqual({ a: "Aortic sclerosis", b: "Mitral regurgitation, moderate" });
});
