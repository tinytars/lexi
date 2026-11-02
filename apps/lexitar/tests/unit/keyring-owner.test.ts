// The rule both sealing lanes resolve a namespace's key ring with, pinned case by case.
//
// It is a pure function precisely so this file can exist: the two callers that apply it reach D1, R2
// and the org key, and the decision they had been making inline was therefore untestable — which is
// how a dev store ended up with three cleartext sidecars nothing would seal and no test to say so.
//
// The two refusals are what these cases exist to hold. A fallback that reached an orphan would end a
// patient's claim on their own bytes, and one that reached a revoked account would overrule the one
// setting that says "not even the operator" — so both are asserted directly rather than left to
// follow from the implementation.
import { describe, it, expect } from "vitest";
import { keyringOwner } from "../../scripts/keyring-owner";

const SLUG = "834bc60d-c937-467d-9e78-3caa734acf45";
const CALLER = "12275343-91b7-431d-ae4a-15c6e092b4a6";
const openableSet = (...ids: string[]) => (id: string) => ids.includes(id);

describe("keyringOwner", () => {
  // The common case, and the one that bounds the blast radius: where the recorded owner can be opened
  // nothing is re-resolved, so no namespace the operator lane already reached moves.
  it("keeps the first writer when their vault can be opened", () => {
    expect(keyringOwner(SLUG, SLUG, openableSet(SLUG, CALLER))).toBe(SLUG);
  });

  it("keeps the first writer even where the slug is also openable, so the recorded owner wins", () => {
    expect(keyringOwner(CALLER, SLUG, openableSet(CALLER, SLUG))).toBe(CALLER);
  });

  // The defect this closes: the oldest row names the CALLER of a mis-attributing route, that account
  // holds no vault at all, and the namespace's own slug is a live account whose ring holds the keys.
  it("falls back to the slug's account when the first writer has no openable vault", () => {
    expect(keyringOwner(CALLER, SLUG, openableSet(SLUG))).toBe(SLUG);
  });

  it("leaves the first writer in place when the slug is no better, so the refusal still names what it tried", () => {
    expect(keyringOwner(CALLER, SLUG, openableSet())).toBe(CALLER);
  });

  // REVOCATION. `openable` is false for a revoked account by construction in both callers, so the
  // fallback cannot select one — asserted from the slug side, which is the only side the fallback
  // could ever have reached.
  it("never resolves to a slug account that has revoked org recovery", () => {
    expect(keyringOwner(CALLER, SLUG, openableSet(CALLER))).toBe(CALLER);
    expect(keyringOwner(CALLER, SLUG, openableSet())).not.toBe(SLUG);
  });

  // ORPHANS. No first writer means no `raw_objects` row attributes the namespace to anybody, and its
  // bytes stay claimable (functions/api/raw/claim.ts). Knowing whose they probably are is not
  // permission to seal them under a key, so the slug is not consulted at all.
  it("returns null for an orphaned namespace even when the slug names an openable account", () => {
    expect(keyringOwner(null, SLUG, openableSet(SLUG))).toBeNull();
  });
});
