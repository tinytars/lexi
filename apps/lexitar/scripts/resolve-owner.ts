// Turning what the operator actually has in hand — the address bar they are looking at — into the
// account whose record it is. Pure: no network, no disk, no cache.
//
// A pasted link does not name an account. It names a CLIENT KEY, which is a slug inside one record's
// own `clients` map (`src/lib/permalink.ts`, `#<client>/<section>[/<anchor>]`), and the mapping to an
// account is not generally invertible — there is no endpoint for it and there deliberately is no
// on-disk index either, because "which family members exist" is exactly the fact the record protects.
//
// So resolution is a ladder, cheapest first, and it stops rather than guesses. Opening someone's
// record to find out whether it is the one being asked for is a disclosure against a person who is not
// the subject of the export, so it never happens implicitly (see `--probe`).
import { decodeSegment, parseHash } from "../src/lib/permalink";
import { normalizeClientId } from "../src/lib/client-id";

/** The client key a pasted URL, bare hash or lone segment names. Normalized, so it is comparable. */
export function clientKeyFromUrl(pasted: string): string {
  const hash = pasted.indexOf("#");
  // A bare segment is accepted, but a URL's own path is not a fallback for a missing fragment: without
  // this, `--url https://host/` would resolve to "https:" and then fail as an unapproved account.
  const raw = hash >= 0 ? pasted.slice(hash + 1).replace(/^\/+/, "") : /[:/]/.test(pasted) ? "" : pasted;
  if (!raw) throw new Error(`${pasted} carries no #<person>/... address to resolve`);

  const link = parseHash(`#${raw}`);
  if (link?.client) return normalizeClientId(link.client);
  if (link) {
    // A section with nobody in front of it: patient-scoped in the browser, meaningless to a tool that
    // has to be told whose record to open. Picking the first approved record would be a guess.
    throw new Error(
      `"${raw}" names a part of a record but not whose it is — paste the address while looking at that ` +
        `person's record, or pass --patient <account-id>`,
    );
  }
  // `parseHash` returns null when no segment is a known section or tab, and `#alex` alone is exactly
  // that — which is what an address bar often holds. The browser depends on that null, so the fallback
  // lives here: the first segment is the person.
  return normalizeClientId(decodeSegment(raw.split("/").filter(Boolean)[0]));
}

export type Resolution =
  | { kind: "none" }
  | { kind: "owner"; ownerAccountId: string; why: string }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Which approved record a client key belongs to, without opening any of them.
 *
 * Rung 3 works because a vault created through the provider flow is keyed by the owner's own account
 * id (`src/App.svelte:746-757`), so the pasted slug often IS the answer.
 */
export function resolveOwner(clientKey: string, grants: { ownerAccountId: string }[]): Resolution {
  if (!grants.length) return { kind: "none" };
  if (grants.length === 1) {
    return { kind: "owner", ownerAccountId: grants[0].ownerAccountId, why: "the only approved record" };
  }
  const byId = grants.find((g) => normalizeClientId(g.ownerAccountId) === clientKey);
  if (byId) return { kind: "owner", ownerAccountId: byId.ownerAccountId, why: "that account's own id" };
  return { kind: "ambiguous", candidates: grants.map((g) => g.ownerAccountId) };
}

/** The key as the vault spells it, since `normalizeClientId` is only `toLowerCase`. */
export function findClientKey(clients: Record<string, unknown>, clientKey: string): string | undefined {
  return Object.keys(clients).find((k) => normalizeClientId(k) === clientKey);
}
