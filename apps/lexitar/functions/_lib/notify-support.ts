// One place that tells a patient an account other than theirs can read their record — the wiring behind
// routes/support-notice.ts's SupportAccessNotice.
//
// Fire-and-forget and never rejecting, like every other send in this codebase (notify-method.ts): the
// access has already been approved, or already happened, by the time this runs, so a mail outage must not
// turn into a failed request. The route's contract is that the notice cannot throw, and this is where
// that is made true.
//
// The address arrives as a lookup rather than a database, so the notice can be tested — and reused —
// without one; `accountEmailLookup` is the D1 half, kept to one line beside it.

import type { D1Database } from "./identity-types";
import { getAccount } from "./identity-accounts";
import { sendSupportAccessNotice, type EmailEnv } from "./email";
import type { SupportAccessNotice } from "./routes/support-notice";

export function accountEmailLookup(db: D1Database): (accountId: string) => Promise<string | null> {
  return async (accountId) => (await getAccount(db, accountId))?.email ?? null;
}

export function supportAccessNotifier(
  context: { waitUntil?: (p: Promise<unknown>) => void },
  env: EmailEnv,
  emailOf: (accountId: string) => Promise<string | null>,
): SupportAccessNotice {
  return async ({ ownerAccountId, event, expiresAt }) => {
    const to = await emailOf(ownerAccountId).catch(() => null);
    if (!to) return;
    const p = sendSupportAccessNotice(env, { to, event, expiresAt }).catch((e) =>
      console.log(`[email] support-access notice failed: ${(e as Error).message}`),
    );
    if (context.waitUntil) context.waitUntil(p);
    else await p;
  };
}
