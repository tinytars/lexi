// W72 (docs/cross-app/10, 15 item 18) — one table saying who may do what.
//
// Before this, authorization was twenty-five `account?.providerKind !== "support"` comparisons spread
// across eight route files. Nothing was wrong with any single one of them; what was wrong was that
// the policy existed nowhere — you could not read it, review it, or test it, only rediscover it by
// grepping. Two consequences seen in this codebase already: a new support route is one forgotten line
// away from being open to every logged-in account, and a question as basic as "what can a clinician
// do that a patient cannot" had no answer short of reading every file.
//
// The table below IS the policy. A route names the capability it needs; this module decides.
//
// WHY ROLES AND NOT PER-ACCOUNT PERMISSIONS: what a principal may do to *their own* data is settled by
// role. What they may do to *someone else's* is settled by a provider_link — a time-boxed, revocable
// grant with its own approval and audit trail — and that is a genuinely different mechanism which this
// module deliberately does not absorb. Collapsing the two would put "Dr. X may read patient Y until
// Thursday" into a static table, and a static table cannot expire.
//
// The support role deliberately holds several distinct capabilities that all resolve to the same
// single role today. That is not redundancy: it is where the seams go when the org role in
// `_lib/org.ts` becomes a principal, and it means that change edits this table instead of eight files.

import type { Account } from "./identity-accounts";

export type Role = "patient" | "primary" | "support";

export type Capability =
  /** Spend money on AI generation — the refresh-finding token. */
  | "ai:spend"
  /** Read the support console's patient list. */
  | "support:patients"
  /** Read and act on the support request queue, including opening a granted vault. */
  | "support:queue"
  /** Read the provider directory and roster. */
  | "support:directory"
  /** Approve a support grant through the crypto-free provider path. */
  | "grant:approve-support"
  /** Erase one's own account and everything under it. */
  | "account:erase-self"
  /** Issue a one-time recovery code for a patient who is locked out (W73). */
  | "recovery:issue";

// The whole policy, in one place. A capability absent from a role's row is denied — there is no
// wildcard and no inheritance, because "support is a superset of clinician" is the kind of assumption
// that is true right up until it silently is not.
const GRANTS: Record<Capability, readonly Role[]> = {
  // Support agents are deliberately excluded: a support agent must not hold money-spending authority
  // (W44 P4b). This is the one capability where clinician outranks support, which is exactly why an
  // inheritance model would have been wrong.
  "ai:spend": ["primary"],
  "support:patients": ["support"],
  "support:queue": ["support"],
  "support:directory": ["support"],
  "grant:approve-support": ["primary", "support"],
  // Every principal may erase itself, including a patient. What that erases differs by role, and the
  // difference is enforced by the erasure plan, not here — see _lib/erasure.ts.
  "account:erase-self": ["patient", "primary", "support"],
  // Clinician only, and the THIRD capability where clinician outranks support — which is again why an
  // inheritance model would have been wrong. A support agent can already open a granted vault through
  // the audited path; letting them also mint account control would make support a superuser.
  "recovery:issue": ["primary"],
};

/**
 * A `provider_kind` of NULL means patient. That mapping is the single assumption this module makes
 * about the schema, stated once here rather than re-derived at every call site — which is how
 * `=== null` and `!== "primary"` came to sit in different files meaning almost, but not exactly,
 * the same thing.
 */
export function roleOf(account: Pick<Account, "providerKind"> | null | undefined): Role | null {
  if (!account) return null;
  return account.providerKind ?? "patient";
}

export function can(role: Role | null, capability: Capability): boolean {
  return role !== null && GRANTS[capability].includes(role);
}

/** Every capability a role holds — for the account endpoint, so a client can render its own UI. */
export function capabilitiesOf(role: Role | null): Capability[] {
  if (role === null) return [];
  return (Object.keys(GRANTS) as Capability[]).filter((c) => can(role, c));
}

// NO `requireCapability(...)` wrapper here, deliberately. Each route already builds its own 403 body
// and logs its own errorCode, and those bodies are part of the API the client parses; a helper that
// returned a canned Response would have quietly changed five of them. The substitution this module is
// for is one line — `me?.providerKind !== "support"` becomes `!can(roleOf(me), "support:queue")` —
// and everything around it stays exactly as it was. Moving the RESPONSE into a helper is a separate
// change with its own risk, and it is not this one.
