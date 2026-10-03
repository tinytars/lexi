// The shape of "tell the patient an account other than theirs can read their record", shared by the two
// routes that have a moment worth telling them about: the approval, and the first open inside that window.
//
// A type rather than a function, because both routes are portable by design (no Cloudflare env, no
// mailer) — the account lookup and the send are wired in by functions/api/support/*.ts. It is a required
// dep rather than an optional one so a route cannot be added, or a wrapper rewritten, with the notice
// quietly missing: the omission is a type error at the call site instead of silence in a patient's inbox.
export type SupportAccessNotice = (o: {
  ownerAccountId: string;
  event: "approved" | "opened";
  expiresAt: string | null;
}) => Promise<void>;
