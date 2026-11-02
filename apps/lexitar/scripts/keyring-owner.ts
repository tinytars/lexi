// WHOSE KEY RING holds a namespace's content keys — which is not the same question as who owns the
// namespace, and conflating the two is what left dev holding cleartext nothing could seal.
//
// Ownership is FIRST WRITER WINS and that is a security property: resolving `raw/alex/` as a whole is
// what stops an attacker PUTting one new file into someone else's folder and thereafter owning a key
// inside it (functions/_lib/raw-owner.ts). Nothing here touches it, and no route reads this module.
//
// But five write sites record the CALLER rather than the subject (scripts/raw-attribution-audit.ts),
// so the first row in a namespace is often somebody else's — and where that somebody has no vault at
// all, the operator lane resolves to an account with no key ring and reports the namespace as one it
// may not touch. Measured on dev 2026-11-02: three cleartext `text/` sidecars under one namespace,
// refused by both the alarm and the cure as "orphaned, or org recovery revoked" when the namespace is
// neither — its oldest row names an account carrying 0 vaults, while the namespace's own slug IS a
// live account whose vault opens through the org recovery envelope and whose ring already held a
// content key for all three files.
//
// THE SLUG IS THE EVIDENCE. A vault keys its first client by the lowercased account id (App.svelte's
// createFirstClient), so where the segment IS a live account the subject is known outright — the rule
// raw-attribution-audit.ts already calls CONFIRMED, and the only one available without opening a
// vault, which is what lets the hosted alarm apply the same rule the local cure does.
//
// IT IS A FALLBACK AND NOT A NEW RULE, and the two conditions on it are the two refusals that must
// survive it:
//   - An ORPHANED namespace has no first writer, and this returns null for one. Its bytes stay
//     claimable by whoever proves they own them (functions/api/raw/claim.ts), and knowing the subject
//     is not the same as being allowed to end that.
//   - A REVOKED org recovery makes an account unopenable, so it is never what `openable` admits —
//     neither as first writer nor as slug. That is the one lever a patient has to say "not even the
//     operator" and it has no --force.
// Where the first writer IS openable the answer is unchanged, so no namespace the operator lane
// already reached resolves anywhere new. Measured on dev: of 6 namespaces, 1 changes and 5 do not.

/**
 * The account whose vault holds `slug`'s content keys, or null when nobody's may be opened for it.
 *
 * `openable` answers whether an account has a vault this lane can open — a vault row, org recovery not
 * revoked, and an envelope for the org principal. The caller supplies it because the two callers
 * measure it differently: the local cure opens the vault, the hosted alarm reads the three D1 columns.
 */
export function keyringOwner(firstWriter: string | null, slug: string, openable: (accountId: string) => boolean): string | null {
  if (!firstWriter) return null;
  if (openable(firstWriter)) return firstWriter;
  // Falling back leaves the first writer in place when the slug is no better, so the caller's existing
  // refusal message still names the account it actually tried.
  return openable(slug) ? slug : firstWriter;
}
