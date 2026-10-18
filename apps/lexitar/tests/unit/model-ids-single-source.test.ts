import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { modelId } from "../../src/lib/model-config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A model id is a price and a capability tier. Every one lives in inference.config.json, the one
// place a deployer changes inference. No behavioural test can catch a hardcoded id elsewhere: it runs
// perfectly, it just bills a tier nobody chose. So this reads the source, the instrument W75 picked
// for a risk that is a call site drifting rather than a behaviour changing (leaf-id-pairing.test.ts:132).
function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(resolve(ROOT, rel)).isDirectory()) return sourceFiles(rel);
    return /\.(ts|svelte)$/.test(name) ? [rel] : [];
  });
}

// Tests are excluded on purpose: naming a model id as a fixture is what a test asserting the
// request params is FOR. The rule is about production call sites.
const MODEL_ID = /["'`](claude-(opus|sonnet|haiku)-[0-9]|gpt-[0-9o])[a-z0-9.-]*["'`]/;

describe("every model id lives in inference.config.json", () => {
  it("no production source names one", () => {
    const offenders = ["src", "functions", "scripts", "server"]
      .flatMap(sourceFiles)
      .filter((f) => MODEL_ID.test(readFileSync(resolve(ROOT, f), "utf8")));
    expect(offenders.map((f) => relative(".", f))).toEqual([]);
  });

  it("chat relays on the cheap tier the CLI calls dev, not the Finding tier", () => {
    expect(modelId("chat")).toBe(modelId("finding", "dev"));
    expect(modelId("chat")).not.toBe(modelId("finding"));
  });
});
