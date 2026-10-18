import { readFileSync } from "node:fs";
import { isMain } from "./is-main";

type Thresholds = { [key: string]: number | Thresholds };

const flatten = (t: Thresholds, prefix = ""): Map<string, number> =>
  new Map(
    Object.entries(t).flatMap(([k, v]) =>
      typeof v === "number" ? [[prefix + k, v] as const] : [...flatten(v, `${prefix}${k} `)],
    ),
  );

export function loweredThresholds(base: Thresholds, head: Thresholds): string[] {
  const now = flatten(head);
  return [...flatten(base)]
    .filter(([key, floor]) => (now.get(key) ?? -Infinity) < floor)
    .map(([key, floor]) => `${key}: ${floor} -> ${now.get(key) ?? "removed"}`);
}

if (isMain(import.meta.url)) {
  const [basePath, headPath] = process.argv.slice(2);
  const read = (p: string): Thresholds => JSON.parse(readFileSync(p, "utf8"));
  const lowered = loweredThresholds(read(basePath), read(headPath));
  if (lowered.length) {
    console.error(`Coverage thresholds may only rise:\n${lowered.join("\n")}`);
    process.exit(1);
  }
}
