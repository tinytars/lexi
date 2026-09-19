import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface Migration {
  name: string;
  sql: string;
}

// Every migrations/*.sql in directory order — never a hand-picked subset, which goes stale as soon as
// a migration is added. `seeds: false` drops the seed files, for callers whose fixtures are their own.
export function migrations({ seeds }: { seeds: boolean }): Migration[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && (seeds || !f.includes("seed")))
    .sort()
    .map((name) => ({ name, sql: readFileSync(DIR + name, "utf8") }));
}
