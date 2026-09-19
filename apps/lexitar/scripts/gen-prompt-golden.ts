// Regenerates tests/fixtures/prompt-golden/*.txt for chat-prompt.ts — the app-owned prompt surface.
//
// The clinical prompt surfaces (finding, ranges, report-extract, marker-groups) moved to
// brain/akesi-pil/tests/gen-prompt-golden.ts in 06 Phase A step 12, so the package ships with test
// coverage of its own prompts. chat-prompt.ts is a separate, unrelated feature and stays here.
//
// Plain .txt, not JSON — a reviewer sees a wording or whitespace change directly in `git diff`, which
// JSON's \n-escaping would hide.
//
// Run ONLY for a deliberate prompt change, and commit the regenerated files in the SAME commit as the
// change that caused them, with a message saying what moved and why.
//
//   npm run prompt:golden
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chatSystemPrompt } from "../src/lib/chat-prompt";
import { isMain } from "./is-main";

// chatSystemPrompt takes "today" as an explicit param rather than reading the ambient clock, so
// (unlike the akesi-pil-owned surfaces) no frozen-clock wrapper is needed here.
export const FROZEN_TODAY = "2026-06-28";

export const DIR = fileURLToPath(new URL("../tests/fixtures/prompt-golden/", import.meta.url));

/** Every golden file this fixture covers, as name → the text it should contain. */
export function promptGolden(): Record<string, string> {
  return {
    // Both renderings, not one: the unit-system branch is the only thing that varies per patient, so
    // covering a single side would let an edit to the other reach production unreviewed.
    "system--chat--metric.txt": chatSystemPrompt(FROZEN_TODAY, "metric"),
    "system--chat--imperial.txt": chatSystemPrompt(FROZEN_TODAY, "imperial"),
  };
}

function main(): void {
  mkdirSync(DIR, { recursive: true });
  for (const f of readdirSync(DIR)) if (f.endsWith(".txt")) rmSync(DIR + f);
  const files = promptGolden();
  for (const [name, text] of Object.entries(files)) writeFileSync(DIR + name, text.endsWith("\n") ? text : text + "\n");
  console.log(`wrote ${Object.keys(files).length} prompt golden file(s) to ${DIR}`);
}

if (isMain(import.meta.url)) main();
