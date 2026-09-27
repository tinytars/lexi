// Two properties no behaviour test can hold: that every privileged route goes through the one helper,
// and that the action vocabulary written to phi_access_events is closed.
//
// The second is the sharper one. functions/_lib/erasure.ts deliberately does NOT delete those rows —
// they outlive account erasure and stay on patients' access screens — so a renamed action leaves two
// names for one event in the historical record with nothing to reconcile them by. A rename has to be a
// failing test, not a silent second vocabulary. Static sweeps derived from the tree, so a new route
// cannot dodge them by being new (the shape tests/unit/org-key-chokepoint.test.ts already uses).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHI_ACCESS_ACTIONS } from "../../functions/_lib/phi-audit";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FUNCTIONS = resolve(APP, "functions");

function tsFiles(dir = FUNCTIONS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

const files = tsFiles();
const rel = (f: string) => f.slice(APP.length + 1);
const mentioning = (needle: string) => files.filter((f) => readFileSync(f, "utf8").includes(needle)).map(rel).sort();

// Every route that serves one person's record to another, and nothing else.
const PRIVILEGED_ROUTES = [
  "functions/api/document-extract.ts",
  "functions/api/providers/patients.ts",
  "functions/api/raw/[[path]].ts",
  "functions/api/vault/[id].ts",
].sort();

describe("privileged reads go through one helper", () => {
  it("finds the functions tree at all, so an empty sweep cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(60);
    expect(files.map(rel)).toEqual(expect.arrayContaining(PRIVILEGED_ROUTES));
  });

  it("is called from exactly the privileged routes", () => {
    expect(mentioning("auditPrivilegedRead")).toEqual(["functions/_lib/phi-audit.ts", ...PRIVILEGED_ROUTES].sort());
  });

  it("keeps the owner exclusion in the helper, so no route can decide it differently", () => {
    expect(mentioning("e.actor === e.subject")).toEqual(["functions/_lib/phi-audit.ts"]);
  });
});

// `support_*` predates this work and `org_*` is the recovery principal's; both are already live on
// patients' screens, so they are named here rather than folded into the frozen list.
const PRE_EXISTING = [
  "org_recovery_minted",
  "org_recovery_revoked",
  "support_access_denied",
  "support_access_expired",
  "support_access_granted",
  "support_access_opened",
  "support_access_requested",
  "support_provider_access_granted",
  "support_provider_access_requested",
  "support_provider_roster_viewed",
];

/** Every audit-action name written as a literal anywhere under functions/. */
function actionLiterals(): string[] {
  const named = new Set<string>();
  for (const f of files) {
    for (const assignment of readFileSync(f, "utf8").match(/\b[A-Za-z]*[Aa]ction *: *[^,;]*/g) ?? []) {
      for (const literal of assignment.match(/"[a-z][a-z0-9]*(?:_[a-z0-9]+)+"/g) ?? []) named.add(literal.slice(1, -1));
    }
  }
  return [...named].sort();
}

describe("the phi_access_events vocabulary is closed", () => {
  it("contains nothing beyond the frozen list and what predates it", () => {
    expect(actionLiterals()).toEqual([...PHI_ACCESS_ACTIONS, ...PRE_EXISTING].sort());
  });

  it("uses every name it freezes, so a rename shows up as a gap rather than as dead vocabulary", () => {
    for (const action of PHI_ACCESS_ACTIONS) expect(mentioning(action).length).toBeGreaterThan(0);
  });

  // The quoted literal, not the bare name: "provider_roster_viewed" is a substring of the pre-existing
  // "support_provider_roster_viewed", and phi-audit.ts names every frozen action because it declares them.
  const writtenIn = (action: string) => mentioning(`"${action}"`).filter((f) => f !== "functions/_lib/phi-audit.ts");

  it("writes each action from one place", () => {
    expect(writtenIn("provider_roster_viewed")).toEqual(["functions/api/providers/patients.ts"]);
    expect(writtenIn("vault_blob_written")).toEqual(["functions/api/vault/[id].ts"]);
    expect(writtenIn("vault_blob_read")).toEqual(["functions/api/vault/[id].ts"]);
    expect(writtenIn("vault_blob_read_ops")).toEqual(["functions/api/vault/[id].ts"]);
    expect(writtenIn("document_text_read")).toEqual(["functions/api/document-extract.ts"]);
    expect(writtenIn("raw_object_read")).toEqual(["functions/api/raw/[[path]].ts"]);
    expect(writtenIn("raw_namespace_listed")).toEqual(["functions/api/raw/[[path]].ts"]);
    expect(writtenIn("provider_access_revoked")).toEqual(["functions/_lib/routes/providers-link-revoke.ts"]);
  });
});
