import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { promptGolden, DIR } from "../../scripts/gen-prompt-golden";

// W72 — the first test coverage the chat prompt has ever had.
//
// This covers chat-prompt.ts only — the clinical prompt surfaces (finding, ranges, report-extract,
// marker-groups) moved to brain/akesi-pil/tests/prompt-golden.test.ts in 06 Phase A step 12, so the
// package ships with test coverage of its own prompts.
//
// The failure mode this must survive is its own maintenance. A fixture regenerated whenever it goes
// red is worse than none, because it reads as coverage. `npm run prompt:golden` regenerates every
// file at once so a deliberate change is one reviewable diff rather than a hand-edit.

const golden = () => promptGolden();
const onDisk = (name: string) => readFileSync(DIR + name, "utf8");

describe("the chat prompt is what it was when someone last looked at it", () => {
  it("the fixture exists at all", () => {
    // Guards the guard: an empty directory would make every assertion below vacuous.
    expect(existsSync(DIR)).toBe(true);
    expect(readdirSync(DIR).filter((f) => f.endsWith(".txt")).length).toBeGreaterThanOrEqual(2);
  });

  it.each(Object.keys(golden()))("%s is unchanged", (name) => {
    expect(onDisk(name).trimEnd()).toBe(golden()[name].trimEnd());
  });

  it("every file on disk is still produced by the generator", () => {
    // The other direction: a prompt variant deleted from the code but left on disk would otherwise sit
    // there being silently asserted against nothing.
    const produced = new Set(Object.keys(golden()));
    const orphans = readdirSync(DIR).filter((f) => f.endsWith(".txt") && !produced.has(f));
    expect(orphans).toEqual([]);
  });

  it("never carries a real patient's name", () => {
    // The fixture is generated from synthetic variants — a pilot name reaching it would be a PHI leak.
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".txt"))) {
      expect(onDisk(f), f).not.toMatch(/\b(pablo|nancy|sekhar)\b/i);
    }
  });
});

// W72 — the retry suffix, which had drifted into two different behaviours.
//
// The CLI accumulated every rejection; functions/api/refresh-finding.ts sent only the latest with
// "fix exactly this problem". W67 measured what that costs — six full Opus generations producing no
// usable output, because the model fixed each named problem and broke a different one — fixed the
// CLI, and left the browser path, which is the one patients use, on the old wording.
describe("both refresh paths ask for a correction the same way", () => {
  it("is empty when nothing has been rejected", async () => {
    const { correctionSuffix } = await import("@pablotech/akesi-pil/finding-generate");
    expect(correctionSuffix([])).toBe("");
  });

  it("carries EVERY prior rejection, numbered", async () => {
    const { correctionSuffix } = await import("@pablotech/akesi-pil/finding-generate");
    const s = correctionSuffix(["duplicate marker group", "bad dataRequisition group", "doctorConversation label"]);
    expect(s).toContain("1. duplicate marker group");
    expect(s).toContain("2. bad dataRequisition group");
    expect(s).toContain("3. doctorConversation label");
    expect(s).toContain("3 previous attempt(s)");
  });

  it("tells the model that fixing the last one alone is not enough", async () => {
    // The sentence that distinguishes this from the wording it replaced. Its absence is the bug.
    const { correctionSuffix } = await import("@pablotech/akesi-pil/finding-generate");
    expect(correctionSuffix(["a"])).toMatch(/ALL of the above at once/);
    expect(correctionSuffix(["a"])).toMatch(/reintroducing an earlier/);
    expect(correctionSuffix(["a"])).not.toMatch(/fix exactly this problem/);
  });

  it("neither path builds a suffix of its own", async () => {
    // Source assertion, deliberately: the failure mode is a SECOND copy appearing, which no
    // behavioural test of the shared one can see.
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    for (const f of ["functions/api/refresh-finding.ts", "src/lib/refresh-client.ts"]) {
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/=== CORRECTION/);
    }
  });
});
