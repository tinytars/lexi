// The decisions inside `npm run vault:rotate`, separated from the D1 and R2 calls that carry them
// out (W76; same split that makes ingest-core.ts testable while ingest.ts stays a shell).
//
// Rotating a credential is the one operation here that can lock a person out of their own record
// permanently: the password is also the KEK over the account private key, which is the only thing
// that unwraps the vault DEK. Every rule below exists because getting it wrong is unrecoverable
// rather than merely wrong, so each is asserted in tests/unit/credential-rotation.test.ts.

export type Method = "password" | "recovery";

export interface CredentialIdentity {
  accountId: string;
  email: string | null;
  displayName: string;
}

/**
 * The exact weak values this repo seeded and then wrote down: for a password, the login-email local
 * part (migrate-accounts.ts minted {slug}@local.invalid) or the display name; for a recovery code,
 * the `recover-{slug}` values AUTH.md tabulates. Nothing is brute-forced — this only asks whether a
 * value we ourselves documented still authenticates.
 */
export function weakCandidates(row: Pick<CredentialIdentity, "email" | "displayName">, method: Method = "password"): string[] {
  const local = (row.email ?? "").split("@")[0].trim().toLowerCase();
  const display = (row.displayName ?? "").trim().toLowerCase();
  const bases = [...new Set([local, display].filter(Boolean))];
  return method === "recovery" ? bases.map((b) => `recover-${b}`) : bases;
}

/** `--account` accepts the full email, the account id, or the email's local part. */
export function matchesSelector(row: Pick<CredentialIdentity, "accountId" | "email">, selectors: string[]): boolean {
  const email = (row.email ?? "").toLowerCase();
  // Every email branch is guarded on the email being present: an account with no email must not be
  // matched by an empty selector, which would silently widen an --account to "this one too".
  if (email && (selectors.includes(email) || selectors.includes(email.split("@")[0]))) return true;
  return selectors.includes(row.accountId.toLowerCase());
}

export interface AccessResult {
  vaultId: string;
  r2Key: string;
  ok: boolean;
  detail?: string;
}

export interface RotationOutcome {
  accountId: string;
  email: string | null;
  /** Envelopes this principal held BEFORE the rotation. The denominator the verdict is measured against. */
  expectedVaults: number;
  /** Re-read from D1 after the write: does the retired credential still authenticate? */
  oldPasswordStillWorks: boolean;
  access: AccessResult[];
}

export interface Verdict {
  ok: boolean;
  reasons: string[];
}

/**
 * Did this rotation cost anyone access?
 *
 * The count is compared against what the principal held BEFORE the write, not against the list that
 * came back. W76 — the check used to be `lost.length === 0` over the returned list alone, which
 * reports "vaults still readable: 0/0 — ok" when the envelope query comes back empty. That is the
 * lockout case stated as a success: a principal now holding a freshly minted credential that opens
 * nothing at all. An empty result is the loudest possible failure here, not the quietest pass.
 */
export function rotationVerdict(o: RotationOutcome): Verdict {
  const reasons: string[] = [];
  if (o.oldPasswordStillWorks) reasons.push("the retired credential still authenticates");
  for (const a of o.access.filter((a) => !a.ok)) reasons.push(`lost access to ${a.r2Key}${a.detail ? " — " + a.detail : ""}`);
  if (o.access.length < o.expectedVaults) {
    reasons.push(`only ${o.access.length} of ${o.expectedVaults} envelope(s) came back — the rest are unaccounted for, not confirmed`);
  }
  return { ok: reasons.length === 0, reasons };
}

export type RotateMode = "check" | "apply" | "verify-access";

export interface RotateArgs {
  mode: RotateMode;
  method: Method;
  selectors: string[];
  mintOrgEnvelope: boolean;
  /** The holder's real current password, from env CURRENT_PASSWORD — never argv, which `ps` and shell history keep. */
  supplied?: string;
}

/**
 * argv → what to do, with every refusal in one place. These throws are the guardrails around a
 * destructive command, so they are decisions rather than plumbing: --apply without a named account
 * would rotate every pilot at once, and --verify-access without a password silently verifies nothing.
 */
export function parseRotateArgs(argv: string[], env: { CURRENT_PASSWORD?: string } = {}): RotateArgs {
  const methodArg = argv[argv.indexOf("--method") + 1];
  const method = (argv.includes("--method") ? methodArg : "password") as Method;
  if (method !== "password" && method !== "recovery") throw new Error(`--method must be password or recovery, got "${methodArg}"`);

  const selectors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--account" && argv[i + 1]) selectors.push(argv[i + 1].toLowerCase());
  }
  const supplied = env.CURRENT_PASSWORD || undefined;

  if (argv.includes("--verify-access")) {
    if (!supplied) throw new Error("--verify-access needs the account's current password in CURRENT_PASSWORD");
    if (!selectors.length) throw new Error("--verify-access needs --account <email|account-id>");
    return { mode: "verify-access", method, selectors, mintOrgEnvelope: false, supplied };
  }
  if (argv.includes("--apply")) {
    if (!selectors.length) throw new Error("--apply needs at least one --account <email|account-id>");
    return { mode: "apply", method, selectors, mintOrgEnvelope: argv.includes("--mint-org-envelope"), supplied };
  }
  return { mode: "check", method, selectors, mintOrgEnvelope: false, supplied };
}

/**
 * Whether the out-of-band password applies to this row. A supplied password is only ever tried
 * against an explicitly named account: trying it against every row turns one holder's secret into
 * an oracle over the whole credentials table.
 */
export function suppliedAppliesTo(row: Pick<CredentialIdentity, "accountId" | "email">, args: RotateArgs): boolean {
  return !!args.supplied && args.selectors.length > 0 && matchesSelector(row, args.selectors);
}
