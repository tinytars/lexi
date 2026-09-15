import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_MODEL } from "../../src/lib/chat-config";
import { MODELS } from "../../scripts/inference-config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A model id is a price and a capability tier, and the app has seven of them. Six lived in a
// `*-config.ts` beside the code that uses them; the seventh was an inline literal in a route handler
// under a "keep the two in sync" comment — which is the exact shape of every drift W75 and W76 have
// found. No behavioural test can catch the NEXT one: a hardcoded id runs perfectly, it just bills a
// tier nobody chose. So this reads the source, the instrument W75 picked for a risk that is a call
// site drifting rather than a behaviour changing (leaf-id-pairing.test.ts:132).
function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(resolve(ROOT, rel)).isDirectory()) return sourceFiles(rel);
    return /\.(ts|svelte)$/.test(name) ? [rel] : [];
  });
}

// Tests are excluded on purpose: naming a model id as a fixture is what a test asserting the
// request params is FOR. The rule is about production call sites.
const ALLOWED = /^(src\/lib\/[a-z-]+-config\.ts|scripts\/inference-config\.ts)$/;
const MODEL_ID = /["'`]claude-(opus|sonnet|haiku)-[0-9][a-z0-9.-]*["'`]/;

describe("every model id lives in a config module", () => {
  it("no production source outside src/lib/*-config.ts or scripts/inference-config.ts names one", () => {
    const offenders = ["src", "functions", "scripts"]
      .flatMap(sourceFiles)
      .filter((f) => !ALLOWED.test(f) && MODEL_ID.test(readFileSync(resolve(ROOT, f), "utf8")));
    expect(offenders.map((f) => relative(".", f))).toEqual([]);
  });

  it("chat relays on the cheap tier the CLI calls dev, not the Finding tier", () => {
    expect(CHAT_MODEL).toBe(MODELS.dev.finding);
    expect(CHAT_MODEL).not.toBe(MODELS.prod.finding);
  });
});
