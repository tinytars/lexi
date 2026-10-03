// The browser half of POST /api/report — the channel a user tells a human that something is wrong
// through (DPG 9B.3/9B.4/9B.6, 9C.2). See MODERATION.md for who reads these and how fast.
//
// Nothing from the record is sent: a reason, an id this app issued, and the user's own words. The
// route scrubs those words anyway, because someone describing a bad answer will quote it back.
//
// The wire shape is declared here rather than imported from functions/api/report.ts because `src/`
// does not import from `functions/`: this is the contract as the browser needs to read it.
export type ReportReason =
  "misleading-answer" | "illegal-content" | "abusive-account";

export interface ReportTarget {
  reason: ReportReason;
  /** An id this app issued — a chat message, or the account being complained about. Never a name. */
  subject?: string;
  /** Where in the product the user was, for triage: "chat", "reports", "provider-access". */
  feature?: string;
}

/** Returns the reference the user is shown, which is the label the filed issue carries. */
export async function fileSafetyReport(
  target: ReportTarget,
  note: string,
): Promise<string> {
  const res = await fetch("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...target, note }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    reference?: string;
    error?: string;
  };
  // The route's own words: it distinguishes "too many from here in the last hour" from "reporting is
  // unavailable on this deployment", and a user who reported something dangerous is owed the difference.
  if (!res.ok) throw new Error(body.error ?? "Could not send this report.");
  return body.reference ?? "";
}
