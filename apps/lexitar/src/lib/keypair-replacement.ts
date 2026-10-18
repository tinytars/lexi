// The decisions a keypair replacement makes before it touches anything, as pure functions.
//
// Split out from scripts/replace-keypair.ts for the reason src/lib/vault-rekey-plan.ts is: the
// write is a handful of statements, while "which of this account's credentials can survive a new
// keypair" and "may this account be replaced at all yet" are where a mistake is silent and locks
// somebody out of their own record permanently.
//
// The shape of the problem, measured on dev rather than inferred. Both published owners hold FOUR
// credential rows — google, passkey, password, recovery — and all four wrap the same 166-byte
// private key under four different KEKs. Replacing the keypair invalidates every one of them at
// once, and only two can be re-written from a terminal.

/** One row of the `credentials` table, as a report needs it: no key material. */
export interface CredentialRow {
  method: string;
  /** The row's `kdf_params`, verbatim. Parsed here rather than by the caller: the shape IS the decision. */
  kdfParams: string;
}

export type CredentialFate =
  /** Its KEK is a password-derived PBKDF2 key, so a new secret re-derives it offline. */
  | { method: string; fate: "rewrap" }
  /** Its KEK lives outside D1 — re-registration in the app is the only way back. */
  | { method: string; fate: "drop"; why: string };

/**
 * WHY A ROW IS CLASSIFIED BY ITS KDF PARAMETERS AND NOT BY ITS METHOD NAME.
 *
 * The question is not "is this a passkey" but "can anything holding only this database row and a
 * terminal re-derive this row's KEK". That is answered by the parameters the row itself stores, so
 * asking them directly means a credential method added after this file was written is classified
 * correctly — conservatively, as a drop — rather than being silently mishandled because its name
 * is not in a list. On dev the four methods answer:
 *
 *   password  {salt, iterations, authHashSha256}   → PBKDF2 over a secret. Re-derivable.
 *   recovery  {salt, iterations, authHashSha256}   → the same, over a recovery code.
 *   google    {"kek":"google-hkdf-v1"}             → HKDF over an OAuth-flow secret. Not here.
 *   passkey   {prfSalt, credentialID, …}           → a WebAuthn PRF on a physical authenticator.
 */
export function classifyCredential(row: CredentialRow): CredentialFate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.kdfParams) as unknown;
  } catch {
    // Unparseable parameters are a drop rather than a throw: the row cannot be re-wrapped either
    // way, and refusing the whole account over one malformed row would leave the published keypair
    // in service — which is strictly worse than the holder re-registering one method.
    return { method: row.method, fate: "drop", why: "its kdf_params is not JSON, so no KEK can be derived from it" };
  }
  const p = parsed as Record<string, unknown>;
  if (p && typeof p.salt === "string" && typeof p.iterations === "number") {
    return { method: row.method, fate: "rewrap" };
  }
  if (p && typeof p.prfSalt === "string") {
    return {
      method: row.method,
      fate: "drop",
      why: "its KEK is a WebAuthn PRF evaluated by a physical authenticator, which no script can reach",
    };
  }
  if (p && typeof p.kek === "string") {
    return { method: row.method, fate: "drop", why: `its KEK is derived by the ${p.kek} flow, not from a stored secret` };
  }
  return { method: row.method, fate: "drop", why: "its kdf_params carries no PBKDF2 salt and iteration count" };
}

export type ReplaceRefusal =
  | { kind: "key-already-replaced"; thumbprint: string }
  | { kind: "no-public-key" }
  | { kind: "no-credentials" }
  | { kind: "nothing-re-wrappable"; methods: string[] }
  | { kind: "no-password-identity" }
  | { kind: "vault-not-rotatable"; vaultId: string; why: string };

/**
 * May this account's keypair be replaced right now?
 *
 * Every arm here is a way for the replacement to succeed and still be wrong, which is why they are
 * refusals and not warnings.
 *
 * `vaultIsRotatable` is the one that carries the phase ordering. Replacing a keypair leaves every
 * envelope the account holds wrapped to a key nobody has the private half of any more, and the DEK
 * rotation that runs next is what re-mints them. So an account holding an envelope on a vault the
 * rotation will refuse must not be replaced: the result is a vault that is both unreadable by its
 * principal and still openable by the published key — the worst of both states, reached by a
 * command that reported success.
 */
export function refuseReplace(args: {
  liveThumbprint: string | null;
  compromisedThumbprint: string;
  credentials: CredentialRow[];
  hasPasswordIdentity: boolean;
  /** Every vault this account holds an envelope on, with whether the DEK rotation would take it. */
  vaults: { vaultId: string; rotatable: true | { why: string } }[];
}): ReplaceRefusal[] {
  const out: ReplaceRefusal[] = [];

  if (args.liveThumbprint === null) {
    out.push({ kind: "no-public-key" });
  } else if (args.liveThumbprint !== args.compromisedThumbprint) {
    // Not an error state — it is the success state, seen a second time. Replacing again would be a
    // fresh lockout of every envelope for no gain, so this is the idempotence of the command.
    out.push({ kind: "key-already-replaced", thumbprint: args.liveThumbprint });
  }

  if (!args.credentials.length) {
    out.push({ kind: "no-credentials" });
  } else if (!args.credentials.some((c) => classifyCredential(c).fate === "rewrap")) {
    // Dropping every row would leave the holder with no way in at all, and no recovery code to be
    // handed either. That is an account deletion wearing a rotation's clothes.
    out.push({ kind: "nothing-re-wrappable", methods: args.credentials.map((c) => c.method).sort() });
  }

  // A fresh password is worth nothing to somebody the sign-in route will not offer a password to.
  if (args.credentials.length && !args.hasPasswordIdentity) out.push({ kind: "no-password-identity" });

  for (const v of args.vaults) {
    if (v.rotatable !== true) out.push({ kind: "vault-not-rotatable", vaultId: v.vaultId, why: v.rotatable.why });
  }

  return out;
}

export function describeReplaceRefusal(r: ReplaceRefusal): string {
  switch (r.kind) {
    case "key-already-replaced":
      return `this account's live public key is ${r.thumbprint}, which is not the published one — it has already been replaced`;
    case "no-public-key":
      return "this account has no public_keys row, so there is nothing to replace and nothing wraps its envelopes";
    case "no-credentials":
      return "this account has no credentials rows — a new keypair would be wrapped under nothing and the holder could never open it";
    case "nothing-re-wrappable":
      return (
        `none of this account's credential methods (${r.methods.join(", ")}) can be re-wrapped from a terminal, ` +
        `so replacing the keypair would delete every way in. The holder has to re-register in the app first`
      );
    case "no-password-identity":
      return "this account has no password identity row, so a new password would be a secret the sign-in route never asks for";
    case "vault-not-rotatable":
      return (
        `vault ${r.vaultId} holds an envelope for this account and the DEK rotation will not take it (${r.why}) — ` +
        `replacing the keypair now would leave that vault unreadable by its principal AND still openable by the published key`
      );
  }
}

export interface ReplaceArgs {
  apply: boolean;
  all: boolean;
  org: boolean;
  accountIds: string[];
}

/** Same shape as parseRekeyArgs, and narrow for the same reason: the destructive default is the one nobody notices. */
export function parseReplaceArgs(argv: string[]): ReplaceArgs {
  const accountIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--account" && argv[i + 1]) accountIds.push(argv[i + 1].toLowerCase());
  }
  const args = { apply: argv.includes("--apply"), all: argv.includes("--all"), org: argv.includes("--org"), accountIds };
  if (args.apply && !args.all && !args.org && !args.accountIds.length) {
    throw new Error("--apply needs --account <uuid> (repeatable), --org, or --all — it will not guess whose keypair you meant");
  }
  if (args.all && args.accountIds.length) throw new Error("--all and --account are mutually exclusive");
  return args;
}
