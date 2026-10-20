// Every word the access page says about a principal, in one pure module.
//
// It is here and not in `packages/frame` because its strings name the product, which
// `neutrality.test.ts` forbids there. It is `now`-parameterised and returns plain data because the
// defect it exists to fix is a wording one: a clinician row read "Dr Smith primary" and a support
// agent's read "owner · awaiting approval", both of them the raw `provider_links.role` column
// reaching a patient. A sentence that is a value can be asserted without mounting a component, so
// every one of them is pinned by `tests/unit/access-vocabulary.test.ts` and no new one can ship
// carrying a column name.
//
// The database keeps calling the column `primary`; renaming it would be a migration against two
// earlier ones, for no gain a patient can see. The translation lives here instead.

import type { ProviderLinkView } from "@tinytars/vault/auth-grants";
import type { PrincipalTone } from "@tinytars/frame/principal-tone";
import { daysUntil, shortDate } from "@tinytars/frame/time-until";

/** What a row IS, in the patient's words rather than the column's. */
export type AccessKind = "clinician" | "support" | "you" | "recovery";

/** `provider_links.role` as a person would say it. The one place the column value is read. */
export const kindOf = (link: Pick<ProviderLinkView, "kind">): "clinician" | "support" =>
  link.kind === "support" ? "support" : "clinician";

/**
 * The chip: the only coloured thing in a row, and the first thing read in it.
 *
 * Tones are the frame's token names, not domain words — the mapping from "a clinician" to "the
 * accent colour" is this app's to make. `title` is the long form for anyone who wants it; the chip
 * itself stays one word so a row of them scans.
 *
 * "SUPPORT" survives here where "primary" and "owner" do not, and that is the distinction rather
 * than an oversight: it is the plain word for who the person is, where the other two are names for
 * a database value that mean nothing to a patient. The test holds the rule in that shape.
 */
export const KIND_CHIP: Record<AccessKind, { label: string; tone: PrincipalTone; title: string }> = {
  clinician: { label: "CLINICIAN", tone: "accent", title: "A doctor or nurse you have shared this record with" },
  support: { label: "SUPPORT", tone: "provider", title: "A LexiTar support agent helping you with this record" },
  you: { label: "YOU", tone: "owner", title: "Your own account" },
  recovery: { label: "RECOVERY", tone: "warn", title: "LexiTar's recovery key" },
};

/** A sentence, and whether it is ordinary or a warning. The row prints both. */
export interface Detail {
  text: string;
  tone: "muted" | "warn";
}

const plain = (text: string): Detail => ({ text, tone: "muted" });

/** Inside this many days of the end, the row starts saying so in the warning tone. */
export const ENDING_SOON_DAYS = 7;

/** "19 Nov", or "17 Feb 2027" once the year stops being this one. */
export const endsOn = (iso: string, now: number, locale?: string): string => shortDate(iso, now, locale);

/** Whole days left, to the nearest day. Negative once the window has closed. */
export const endsIn = (iso: string, now: number): number => daysUntil(iso, now);

/** What somebody who has asked and not been answered is asking FOR. */
export function pendingSentence(link: Pick<ProviderLinkView, "kind">): Detail {
  return plain(
    kindOf(link) === "support"
      ? "Asked for temporary access to help you."
      : "Asked to read your record."
  );
}

/**
 * What a granted link's window means, said once, the same way on every surface that shows it.
 *
 * Three shapes and not two: a window that has run out is not the same as one that was never set,
 * and neither is the same as one about to run out. The last of those is the only place this raises
 * its voice, because it is the only one the owner can still act on before anything is lost.
 */
export function grantSentence(link: Pick<ProviderLinkView, "expiresAt">, now: number, locale?: string): Detail {
  if (!link.expiresAt) return plain("Can read your record. No end date — until you revoke.");
  const date = endsOn(link.expiresAt, now, locale);
  const days = endsIn(link.expiresAt, now);
  if (Number.isNaN(days)) return plain("Can read your record. The end date could not be read.");
  if (days < 0 || (days === 0 && Date.parse(link.expiresAt) <= now)) {
    return plain(`Ended ${date}. They can no longer read your record.`);
  }
  if (days <= ENDING_SOON_DAYS) {
    const left = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    return { text: `Ends ${left} (${date}).`, tone: "warn" };
  }
  return plain(`Ends ${date}. You can renew or revoke at any time.`);
}

/** The clinician's own side of the same grant, so both ends print the same date. */
export function grantedUntil(expiresAt: string | null, now: number, locale?: string): string {
  return expiresAt ? `Granted until ${endsOn(expiresAt, now, locale)}` : "Granted with no end date";
}

/** The owner's own row. It exists to answer "and me?" before the question is asked. */
export const YOU_SENTENCE: Detail = plain("This is you. Your own reading is never listed below.");

/**
 * The recovery key, as a principal rather than as a settings block — which is where it was, four
 * screens into a different modal, while being an answer to "who can open my record".
 */
export function recoverySentence(held: boolean, revokedAt: string | null, uses: number, now: number, locale?: string): Detail {
  if (!held) {
    const when = revokedAt ? ` ${endsOn(revokedAt, now, locale)}` : "";
    return plain(`Removed${when}. Your password is the only key to this record.`);
  }
  const used = uses === 0 ? "Never used." : uses === 1 ? "Used once." : `Used ${uses} times.`;
  return plain(`Can open your record if you lose your password. ${used}`);
}
