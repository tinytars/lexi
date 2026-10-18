// @vitest-environment jsdom
import { it, expect } from "vitest";
import { render } from "../support/mount";
import Analysis from "../../src/lib/Analysis.svelte";
import { syntheticVault, workerSeed } from "../fixtures/synthetic-patient";

const seed = workerSeed(0);
const client = syntheticVault(seed).clients[seed];

it("Analysis renders no headings outside its cells, and keeps its block anchors", () => {
  const el = render(Analysis, { client });
  expect(el.querySelectorAll(".analysis .leaf-card").length).toBeGreaterThan(0);
  expect(el.querySelectorAll(".analysis h2")).toHaveLength(0);
  expect(el.querySelectorAll(".analysis .an-block[id]").length).toBeGreaterThan(0);
});
