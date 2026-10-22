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
import { CONSENT_LIFECYCLE_ACTIONS, PHI_ACCESS_ACTIONS, PRIVILEGED_READ_ACTIONS } from "../../functions/_lib/phi-audit";

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

/**
 * Every audit-action name written as a literal anywhere under functions/.
 *
 * `[:=]`, not `:` alone. A route that picks its name with a branch writes `const action = … ? "a" :
 * "b";` and then passes the variable, which the property-only form could not see — and a name this
 * sweep cannot see is a name outside the closed vocabulary, which is the one thing it exists to
 * prevent. `[^,;]` spans newlines, so a ternary broken over four lines is still one match.
 */
function actionLiterals(): string[] {
  const named = new Set<string>();
  for (const f of files) {
    for (const assignment of readFileSync(f, "utf8").match(/\b[A-Za-z]*[Aa]ction *[:=] *[^,;]*/g) ?? []) {
      for (const literal of assignment.match(/"[a-z][a-z0-9]*(?:_[a-z0-9]+)+"/g) ?? []) named.add(literal.slice(1, -1));
    }
  }
  return [...named].sort();
}

describe("the phi_access_events vocabulary is closed", () => {
  it("contains nothing beyond the frozen list and what predates it", () => {
    expect(actionLiterals()).toEqual([...PHI_ACCESS_ACTIONS, ...PRE_EXISTING].sort());
  });

  // The split the clinician's ask made necessary. `auditPrivilegedRead` takes a PrivilegedReadAction
  // and nothing else, because its owner exclusion is right for a disclosure and wrong for a consent
  // change: a patient granting their own doctor access is the row that patient most needs to see,
  // and actor === subject there, so the chokepoint would silently drop it. The compiler holds the
  // narrowing; these two hold the lists it narrows over.
  it("splits the vocabulary into reads and consent changes with nothing in both and nothing outside", () => {
    expect(PHI_ACCESS_ACTIONS).toEqual([...PRIVILEGED_READ_ACTIONS, ...CONSENT_LIFECYCLE_ACTIONS]);
    const overlap = PRIVILEGED_READ_ACTIONS.filter((a) => (CONSENT_LIFECYCLE_ACTIONS as readonly string[]).includes(a));
    expect(overlap).toEqual([]);
  });

  it("keeps consent-lifecycle names out of the read chokepoint", () => {
    const chokepoint = readFileSync(resolve(FUNCTIONS, "_lib", "phi-audit.ts"), "utf8");
    // The field is typed `PrivilegedReadAction`, so a consent name handed to `auditPrivilegedRead`
    // is a compile error rather than a row on the wrong side of the owner exclusion.
    expect(chokepoint).toContain("action: PrivilegedReadAction;");
    for (const action of CONSENT_LIFECYCLE_ACTIONS) {
      expect(mentioning(`"${action}"`), `${action} is a consent change and must not be audited as a read`).not.toContain(
        "functions/api/vault/[id].ts",
      );
    }
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
    expect(writtenIn("provider_access_granted")).toEqual(["functions/api/providers/grant.ts"]);
    // One handler, two mounts: /api/support/request and /api/providers/request are the same body, so
    // all three "asked for access" names are written in the one file and the mounts carry none.
    expect(writtenIn("provider_access_requested")).toEqual(["functions/_lib/routes/access-request.ts"]);
    expect(writtenIn("support_access_requested")).toEqual(["functions/_lib/routes/access-request.ts"]);
    expect(writtenIn("support_provider_access_requested")).toEqual(["functions/_lib/routes/access-request.ts"]);
  });
});
