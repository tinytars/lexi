// W73 — one place that tells an account owner a login method was added.
//
// It exists as a helper rather than three inline blocks because the notice is the *residual* control
// for accounts that cannot be challenged (see step-up.ts): if it is easy to forget on one path, the
// account type that most needs it is exactly the one that will be missed.
//
// Fire-and-forget, like every other send in this codebase: a mail outage must never fail the operation
// the user actually asked for, and the operation has already succeeded by the time this runs.

import type { D1Database } from "./identity-types";
import { getAccount } from "./identity-accounts";
import { sendMethodAddedNotice, type EmailEnv } from "./email";

export async function notifyMethodAdded(
  context: { waitUntil?: (p: Promise<unknown>) => void },
  env: EmailEnv & { DB: D1Database },
  accountId: string,
  method: string,
): Promise<void> {
  const account = await getAccount(env.DB, accountId);
  if (!account?.email) return;
  const p = sendMethodAddedNotice(env, { to: account.email, method }).catch((e) =>
    console.log(`[email] method-added notice failed: ${(e as Error).message}`),
  );
  if (context.waitUntil) context.waitUntil(p);
  else await p;
}
