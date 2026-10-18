// The decisions a DEK rotation makes before it touches anything, as pure functions.
//
// Split out from scripts/vault-rekey.ts so the refusals can be tested without a live store. They
// are the part worth testing: the write itself is three statements, while "may this DEK be wrapped
// to this key" and "is this envelope set complete" are where a mistake is silent and permanent.

/** A principal that must hold an envelope on the rotated vault, with the key the DEK is wrapped to. */
export interface Principal {
  accountId: string;
  publicKeyJwk: JsonWebKey;
  /** RFC 7638 thumbprint of the above, so a report can name a key without printing it. */
  thumbprint: string;
}

export interface CompromisedKey {
  role: string;
  accountId: string;
  thumbprint: string;
}

export type RekeyRefusal =
  | { kind: "no-principals" }
  | { kind: "compromised-key"; accountId: string; thumbprint: string; role: string }
  | { kind: "duplicate-principal"; accountId: string }
  | { kind: "missing-org-envelope" }
  | { kind: "rotation-pending"; stagingKey: string | null };

/**
 * May this vault be re-keyed to this set of principals?
 *
 * The first refusal is the one that makes the phase ordering an invariant rather than a note in a
 * plan. A fresh DEK wrapped to a public key whose private half is published is a fresh DEK that is
 * already compromised — the rotation would complete, verify, report success, and leave the vault
 * exactly as readable as before. There is no way to detect that afterwards from the vault, so it is
 * refused up front, by thumbprint, against the list recorded in scripts/compromised-public-keys.json.
 */
export function refuseRekey(
  principals: Principal[],
  compromised: CompromisedKey[],
  orgAccountId: string,
  rotationPending: boolean,
  stagingKey: string | null,
): RekeyRefusal[] {
  const out: RekeyRefusal[] = [];

  // A half-finished rotation already reserved an R2 key for this vault. Starting a second one would
  // orphan the first's staged blob and race its commit, so it is a stop rather than a warning.
  if (rotationPending) out.push({ kind: "rotation-pending", stagingKey });

  if (!principals.length) out.push({ kind: "no-principals" });

  const seen = new Set<string>();
  for (const p of principals) {
    if (seen.has(p.accountId)) out.push({ kind: "duplicate-principal", accountId: p.accountId });
    seen.add(p.accountId);
  }

  const bad = new Map(compromised.map((c) => [c.thumbprint, c]));
  for (const p of principals) {
    const hit = bad.get(p.thumbprint);
    if (hit) out.push({ kind: "compromised-key", accountId: p.accountId, thumbprint: p.thumbprint, role: hit.role });
  }

  // Dropping the org envelope would make the vault unrecoverable by the operator path every other
  // script in this tree depends on, and nothing downstream would notice until a recovery was needed.
  if (principals.length && !seen.has(orgAccountId)) out.push({ kind: "missing-org-envelope" });

  return out;
}

/**
 * Is this vault in the remediation's scope at all?
 *
 * Only a vault holding at least one principal whose key was published is. Measured on dev rather
 * than assumed: of six vaults there, five hold such a principal and one holds a single principal
 * whose key was never published — and that one needs nothing. Without this distinction the report
 * said "6 of 6 cannot be rotated yet", which reads as six units of work and sends the operator
 * looking for a keypair to replace on a vault that has no compromised key to replace.
 *
 * WHY THIS IS KEYED BY ACCOUNT ID AND THE REFUSALS ABOVE ARE KEYED BY THUMBPRINT. The two questions
 * are asked at different moments and the answers diverge in between, which is a bug this very file
 * had until the keypair-replacement command was written against it. Scope asks a question about
 * history — was an envelope on this vault ever minted to a key that got published — and the answer
 * does not stop being yes when `public_keys` moves on, because the envelope row is unchanged and is
 * still wrapped to the old, published key. Refusal asks a question about the present — is a fresh
 * DEK about to be wrapped to a key an attacker holds — and the answer does become no the moment the
 * keypair is replaced, which is exactly what has to happen for the rotation to proceed at all.
 *
 * Keying scope by thumbprint too would therefore have made the rotation a silent no-op in the one
 * ordering the remediation actually runs in: replace the keypairs, and every vault then reports
 * "needs nothing" while every envelope on it is still openable by a published private key. A
 * refusal would have been survivable; a vault reported as needing nothing is not.
 *
 * The envelope does not record which recipient key it was wrapped to — only `principal_account_id`
 * and the sender's ephemeral key — so the account id is the strongest thing there is to ask. That
 * makes scope deliberately generous: a vault whose envelope was minted *after* the replacement is
 * scoped in and rotated for nothing. An unnecessary rotation costs one R2 object and one D1 write;
 * a missed one leaves a live decryption path published forever.
 *
 * The org principal counts. Its private half is wrapped under a passphrase that was never
 * published, so an org-only vault is not openable from a clone — but the org keypair is being
 * replaced regardless, which means every envelope minted to the old one has to be re-minted.
 */
export function rekeyScope(principals: Principal[], compromised: CompromisedKey[]): CompromisedKey[] {
  const bad = new Map(compromised.map((c) => [c.accountId, c]));
  return principals.map((p) => bad.get(p.accountId)).filter((c): c is CompromisedKey => c !== undefined);
}

/**
 * The refusals that a keypair replacement will NOT clear.
 *
 * Asked by scripts/replace-keypair.ts, before any keypair is replaced, about every vault the
 * account holds an envelope on. At that moment `refuseRekey` necessarily reports `compromised-key`
 * for each of them — the published key is still the live one, which is the exact condition the
 * replacement exists to fix — so taking the refusal list at face value there would refuse the whole
 * remediation on the grounds that the remediation has not happened yet.
 *
 * Every other arm survives the replacement and is a real block: `missing-org-envelope` and
 * `no-principals` are properties of the envelope set, `rotation-pending` of a half-finished
 * rotation, `duplicate-principal` of the rows themselves. None of them is made false by a new
 * keypair, so an account holding an envelope on such a vault must not be replaced — the rotation
 * that would re-mint that envelope is never going to run.
 */
export function blocksAfterReplacement(refusals: RekeyRefusal[]): RekeyRefusal[] {
  return refusals.filter((r) => r.kind !== "compromised-key");
}

export function describeRefusal(r: RekeyRefusal): string {
  switch (r.kind) {
    case "no-principals":
      return "this vault has no envelope rows at all — there is nobody to wrap a new DEK to";
    case "compromised-key":
      return (
        `account ${r.accountId} (${r.role}) still holds the PUBLISHED public key ${r.thumbprint} — ` +
        `wrapping a fresh DEK to it would produce a fresh DEK that is already compromised. ` +
        `Replace this account's keypair first`
      );
    case "duplicate-principal":
      return `account ${r.accountId} appears twice in the envelope set`;
    case "missing-org-envelope":
      return "the org principal holds no envelope on this vault — rotating would strand the operator recovery path";
    case "rotation-pending":
      return (
        `a rotation is already pending on this vault` +
        (r.stagingKey ? ` (staged at ${r.stagingKey})` : "") +
        ` — finish or clear it before starting another`
      );
  }
}

export interface RekeyArgs {
  apply: boolean;
  all: boolean;
  vaultIds: string[];
}

/**
 * Deliberately narrower than the other operator CLIs in this tree: `--apply` with no selector is an
 * error rather than "every vault", because the two stores differ in size and the destructive default
 * is the one nobody notices until it has run.
 */
export function parseRekeyArgs(argv: string[]): RekeyArgs {
  const vaultIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault" && argv[i + 1]) vaultIds.push(argv[i + 1].toLowerCase());
  }
  const args = { apply: argv.includes("--apply"), all: argv.includes("--all"), vaultIds };
  if (args.apply && !args.all && !args.vaultIds.length) {
    throw new Error("--apply needs --vault <uuid> (repeatable) or --all — it will not guess which vault you meant");
  }
  if (args.all && args.vaultIds.length) throw new Error("--all and --vault are mutually exclusive");
  return args;
}

/**
 * The `{id}` in `data-{id}.enc`, which is what the org-key audit row is keyed by and what
 * scripts/org-unwrap.ts refuses unless it matches `/^[a-z0-9-]+$/`. Taken from the stored `r2_key`
 * rather than from `vault_id`: the two diverge the moment a rotation repoints the row, and the blob
 * is named by the former.
 */
export function stemOf(r2Key: string): string {
  const m = /^(?:.*\/)?data-(.+)\.enc$/.exec(r2Key);
  if (!m) throw new Error(`cannot read a vault id out of r2_key ${JSON.stringify(r2Key)}`);
  return m[1].toLowerCase();
}
