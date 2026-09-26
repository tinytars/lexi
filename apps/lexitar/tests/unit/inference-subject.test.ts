// Whose record an inference answers about, and what opens its documents. Pure, so it is pinned here
// rather than through six routes that each build the same subject.
import { describe, it, expect } from "vitest";
import { subjectOf, type Subject } from "../../functions/_lib/inference/subject";

const KEY = "A".repeat(43) + "=";
const SESSION = { accountId: "acct-1" };

describe("subjectOf", () => {
  it("carries the session's own account and the record it named", () => {
    expect(subjectOf(SESSION, { clientId: "alex" })).toMatchObject({ accountId: "acct-1", clientId: "alex" });
  });

  it("carries the keys that open the record's documents", () => {
    const subject = subjectOf(SESSION, { clientId: "alex", rawKeys: { "labs.pdf": KEY } }) as Subject;

    expect(subject.rawKeys).toEqual({ "labs.pdf": KEY });
  });

  // Every request before the sweep, and every record with nothing sealed yet, sends none.
  it("is an empty key map, not a refusal, for a body carrying no keys", () => {
    expect((subjectOf(SESSION, { clientId: "alex" }) as Subject).rawKeys).toEqual({});
  });

  // A key the Worker would not import is dropped, not refused: the request may still be answerable
  // from documents that are not sealed, and the corpus refuses per document when it is not.
  it("drops a malformed key rather than refusing the request", () => {
    const subject = subjectOf(SESSION, { clientId: "alex", rawKeys: { "labs.pdf": "nonsense" } }) as Subject;

    expect(subject.rawKeys).toEqual({});
  });

  it("refuses a body that names no record", () => {
    expect(subjectOf(SESSION, {})).toMatchObject({ status: 400, errorCode: "no_client_id" });
  });

  // The bearer is a deployment-wide secret: it buys entry to the route, never whose reports may be
  // read, so a caller holding only it has to name the account.
  it("makes a bearer-only caller name the account it acts for", () => {
    expect(subjectOf(null, { clientId: "alex" })).toMatchObject({ status: 400, errorCode: "no_account_id" });
  });

  it("gives a bearer-only caller the same key map, once it has named one", () => {
    const subject = subjectOf(null, { clientId: "alex", accountId: "acct-2", rawKeys: { "labs.pdf": KEY } }) as Subject;

    expect(subject).toEqual({ accountId: "acct-2", clientId: "alex", rawKeys: { "labs.pdf": KEY } });
  });
});
