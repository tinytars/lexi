import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A workflow nobody launched by hand has nobody watching it fail. The guard is here, not in review:
// the next scheduled workflow added without a notify job fails this test instead of failing silently
// for a month. Dispatch-only workflows (ops.yml) are exempt — a human is already watching that run.

const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../../../.github/workflows");

const triggers = (yaml: string): string => {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.startsWith("on:"));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
};

const unattended = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml"))
  .filter((f) => /^\s+(schedule|push):/m.test(triggers(readFileSync(join(DIR, f), "utf8"))));

describe("unattended workflows report their own failures", () => {
  it("finds the workflows that run without anyone watching", () => {
    expect(unattended).toContain("ci.yml");
    expect(unattended).toContain("snapshot.yml");
    expect(unattended).not.toContain("ops.yml");
  });

  it.each(unattended)("%s calls notify-failure.yml", (file) => {
    expect(readFileSync(join(DIR, file), "utf8")).toMatch(/\/workflows\/notify-failure\.yml@[0-9a-f]{40}/);
  });
});
