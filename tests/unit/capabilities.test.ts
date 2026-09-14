// W72 item 18 — the authorization policy, now that there is one to test.
//
// Before this module the policy could not be tested at all: it was twenty-five comparisons in eight
// files, and the only way to ask "can a support agent spend money on AI generation" was to read
// provider-token.ts. The matrix below is that question asked for every role and every capability at
// once, which is the thing a reviewer actually wants and could not previously have.
//
// The second half is the one that matters for regressions: it walks `functions/` and asserts that no
// route has gone back to comparing `providerKind` inline. A policy table that half the routes ignore
// is worse than no table, because it reads as authoritative.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { can, roleOf, capabilitiesOf, type Role, type Capability } from "../../functions/_lib/capabilities";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("roleOf", () => {
  it("reads a NULL provider_kind as patient — the schema's one implicit mapping", () => {
    expect(roleOf({ providerKind: null })).toBe("patient");
    expect(roleOf({ providerKind: "primary" })).toBe("primary");
    expect(roleOf({ providerKind: "support" })).toBe("support");
  });

  it("has no role for a missing account, so an unknown caller is never a patient by default", () => {
    // The old inline form was `me?.providerKind !== "support"`, which is correct — but its sibling
    // `me?.providerKind === null` was TRUE for a missing account under optional chaining only because
    // `undefined === null` is false. Getting that wrong would have made "no such account" mean
    // "patient". Nothing is a role here unless it is an account.
    expect(roleOf(null)).toBeNull();
    expect(roleOf(undefined)).toBeNull();
    expect(can(roleOf(null), "support:queue")).toBe(false);
    expect(can(roleOf(null), "account:erase-self")).toBe(false);
  });
});

describe("the policy matrix", () => {
  const rows: [Capability, Role[]][] = [
    ["ai:spend", ["primary"]],
    ["support:patients", ["support"]],
    ["support:queue", ["support"]],
    ["support:directory", ["support"]],
    ["grant:approve-support", ["primary", "support"]],
    ["account:erase-self", ["patient", "primary", "support"]],
    ["recovery:issue", ["primary"]],
  ];
  const ALL: Role[] = ["patient", "primary", "support"];

  it.each(rows)("%s is held by exactly the expected roles", (cap, holders) => {
    for (const role of ALL) expect(can(role, cap)).toBe(holders.includes(role));
  });

  it("denies a support agent the money-spending capability", () => {
    // W44 P4b, and the specific reason the policy is a table rather than an inheritance chain: support
    // outranks clinician everywhere else and must not here.
    expect(can("support", "ai:spend")).toBe(false);
    expect(can("primary", "ai:spend")).toBe(true);
  });

  it("gives a patient nothing beyond erasing themselves", () => {
    expect(capabilitiesOf("patient")).toEqual(["account:erase-self"]);
  });

  it("lists a role's capabilities without inventing any", () => {
    // Note what is NOT here: recovery:issue. A support agent can already open a granted vault through
    // the audited path; letting them mint account control as well would make support a superuser.
    expect(capabilitiesOf("support").sort()).toEqual(
      ["account:erase-self", "grant:approve-support", "support:directory", "support:patients", "support:queue"].sort(),
    );
    expect(capabilitiesOf(null)).toEqual([]);
  });

  it("covers every capability in the matrix above, so a new one cannot land untested", () => {
    const declared = new Set(ALL.flatMap((r) => capabilitiesOf(r)));
    expect([...declared].sort()).toEqual(rows.map(([c]) => c).sort());
  });
});

describe("no route decides authorization on its own", () => {
  function tsFilesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return tsFilesUnder(full);
      return name.endsWith(".ts") ? [full] : [];
    });
  }

  it("has no inline providerKind comparison left in functions/api", () => {
    // `_lib/identity.ts` maps the column and `_lib/capabilities.ts` interprets it; everywhere else a
    // comparison against a role literal is a gate that bypasses the table.
    //
    // The sweep is deliberately stricter than "caller gates only". Three of the sites it first caught
    // classified the TARGET account rather than the caller — not authorization, but still a second
    // statement of what a NULL provider_kind means, which is precisely the duplication that let
    // `=== null` and `!== "clinician"` drift apart. They read `roleOf(target)` now.
    const offenders = tsFilesUnder(resolve(ROOT, "functions/api"))
      .filter((f) => /providerKind\s*(===|!==)\s*("primary"|"support"|null)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("finds the route files at all, so an empty sweep cannot pass silently", () => {
    expect(tsFilesUnder(resolve(ROOT, "functions/api")).length).toBeGreaterThan(20);
  });

  it("has every capability the table declares actually named by a route", () => {
    // The other direction: a capability nothing checks is dead policy, which rots.
    const src = tsFilesUnder(resolve(ROOT, "functions")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const cap of capabilitiesOf("support").concat(capabilitiesOf("primary"))) {
      expect(src, `capability "${cap}" is declared but no route requires it`).toContain(`"${cap}"`);
    }
  });
});
