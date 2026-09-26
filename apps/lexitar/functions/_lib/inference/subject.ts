// Whose record an inference answers about, on the routes that accept the provider bearer as well as
// the patient's own session.
//
// The corpus needs an ACCOUNT to authorise against, and the two credentials carry different things.
// A session IS an account. The provider bearer is a deployment-wide secret — treating it as
// permission to read any namespace is the hole raw-owner.ts was written to close — so a bearer-only
// caller has to NAME the account it acts for, and `rawAccessFor` still has to agree that the account
// owns the namespace. The bearer buys entry to the route; it never buys the reports.
//
// Pure, and separate from the route, because it is the same decision three times: session first,
// bearer second, and no answer at all without a subject.
import { parseRawKeys, type RawKeyMap } from "../../../src/lib/raw-cipher";

/** A refusal, in the shape a route's own error reply takes. */
export interface SubjectRefusal {
  status: number;
  errorCode: string;
  error: string;
}

export interface Subject {
  accountId: string;
  clientId: string;
  /**
   * The content keys that open this client's stored originals, from the caller's own vault.
   *
   * It rides with the subject because it is scoped to exactly the namespace the subject names: a key
   * for someone else's file is not a key to anything, since `rawAccessFor` decides WHICH objects are
   * read and this map only decides whether they can be opened.
   */
  rawKeys: RawKeyMap;
}

export function subjectOf(
  session: { accountId: string } | null,
  body: { clientId?: unknown; accountId?: unknown; rawKeys?: unknown },
): Subject | SubjectRefusal {
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) return { status: 400, errorCode: "no_client_id", error: "clientId is required" };
  const rawKeys = parseRawKeys(body);
  if (session) return { accountId: session.accountId, clientId, rawKeys };
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  if (!accountId) {
    return { status: 400, errorCode: "no_account_id", error: "accountId is required when authenticating with the provider token" };
  }
  return { accountId, clientId, rawKeys };
}
