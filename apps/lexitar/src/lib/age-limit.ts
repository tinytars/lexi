import { ageYears } from "@pablotech/akesi/ranges";

// DPG indicator 9C.3 — the Terms' 16+ limit, enforced rather than merely stated.
//
// WHY THIS RUNS IN THE BROWSER. A birth year never reaches the server: onboarding folds it into the
// Client record (App.svelte createFirstClient) and persistClient encrypts the whole vault before it
// leaves the page, so there is no column and no route that receives it. Checking an age server-side
// would mean newly sending a birth date to the server, which costs more privacy than it buys. The
// server records only that the check passed (accounts.age_attested_at, migration 0016).
//
// The age itself is computed by `ageYears`, already this app's single age computation
// (src/lib/chat-context.ts) — a second one would drift.
export const MIN_AGE = 16;

export const DOB_REQUIRED_MESSAGE = `A birth year is required — ${MIN_AGE} is the minimum age for this service.`;
export const UNDERAGE_MESSAGE = `This service is for people aged ${MIN_AGE} and over.`;

/**
 * The reason a dob is refused, or null when it passes.
 *
 * Year-granular by construction: onboarding stores `${year}-01-01`, so someone who turns 16 later
 * this calendar year passes. That is all the data the design collects, and 9C.3 asks for measures
 * protecting underage users, not identity verification — MODERATION.md says so in as many words.
 */
export function ageRefusal(dob: string | undefined): string | null {
  const age = ageYears(dob ?? "");
  if (age === null) return DOB_REQUIRED_MESSAGE;
  return age < MIN_AGE ? UNDERAGE_MESSAGE : null;
}

/**
 * Record that the gate ran and passed. The server stores a timestamp and nothing else — no birth
 * year, no age (migrations/0016_age_attestation.sql). A failure throws, which puts the refusal in
 * front of the user rather than creating a record whose gate left no trace.
 */
export async function attestAge(): Promise<void> {
  const res = await fetch("/api/account", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ageAttested: true }),
  });
  if (!res.ok) throw new Error("Could not confirm your age with the server. Please try again.");
}
