import type { Account, AuditStore, ProviderKind, ProviderLinkStore } from "@tinytars/vault/stores";
import { can, roleOf } from "../capabilities";
import { logRequest } from "../log";
import { json } from "../http";

// One principal asks another for access. W44 P4b gave this to support agents; W-provider-request gives
// it to clinicians, which is what makes a doctor reachable at all — before it, the only way one was
// added was the patient finding them unprompted.
//
// The request creates a PENDING (invited) link and nothing else. No envelope, so the asker holds no
// key until the subject approves in their own browser, and approving is a cryptographic act no server
// and no command line can perform (docs/RECORD-EXPORT.md). Three shapes, decided by the target:
//
//   patient target   → a RECORD request. On approval the patient wraps their DEK to the asker.
//   provider target  → a ROSTER request. A provider owns nothing encrypted, so approval is metadata.
//   support target   → refused. A support agent has no roster to share and no record of their own.
//
// MOUNTED TWICE, deliberately, at /api/support/request and /api/providers/request. The alternative
// was to widen the support path to accept clinicians, which is one line — and then the URL says
// "support" while two shipped consumers call it meaning something else. The shape here is the one
// support-approve.ts and providers-approve-support.ts already use: portable handler, thin mount.

export interface AccessRequestDeps {
  /** The URL this instance is mounted at. Only the log line reads it, and it must not be guessed. */
  route: string;
  requireSession(): Promise<{ accountId: string } | Response>;
  getAccount(id: string): Promise<Account | null>;
  getAccountByEmail(email: string): Promise<Account | null>;
  /** The first vault of an owner, for the audit row's subject. Empty for a provider target. */
  listVaultsForOwner(ownerAccountId: string): Promise<{ vaultId: string }[]>;
  links: ProviderLinkStore;
  audit: AuditStore;
}

export async function accessRequestHandler(request: Request, deps: AccessRequestDeps): Promise<Response> {
  const start = Date.now();
  const log = (status: number, errorCode?: string) =>
    logRequest({ route: deps.route, status, latencyMs: Date.now() - start, errorCode });

  const session = await deps.requireSession();
  if (session instanceof Response) {
    log(401, "unauthorized");
    return session;
  }
  const me = await deps.getAccount(session.accountId);
  const myRole = roleOf(me);
  if (!can(myRole, "access:request")) {
    log(403, "not_a_provider");
    return json(403, { error: "not a provider" });
  }
  // Narrowed rather than cast: the capability above admits exactly these two roles, and writing the
  // narrowing out means a third role added to that row is a type error here instead of a bad `role`
  // column nobody notices until a patient's screen says "patient · wants to help".
  const asker: ProviderKind = myRole === "support" ? "support" : "primary";

  let body: { ownerEmail?: unknown };
  try {
    body = await request.json();
  } catch {
    log(400, "bad_json");
    return json(400, { error: "invalid JSON" });
  }
  if (typeof body.ownerEmail !== "string" || !body.ownerEmail) {
    log(400, "bad_body");
    return json(400, { error: "ownerEmail required" });
  }

  const target = await deps.getAccountByEmail(body.ownerEmail);
  if (!target) {
    log(404, "not_found");
    return json(404, { error: "account not found" });
  }
  if (target.id === session.accountId) {
    log(400, "self_target");
    return json(400, { error: "cannot request access to yourself" });
  }
  const targetRole = roleOf(target);
  if (targetRole === "support") {
    log(400, "unsupported_target");
    return json(400, { error: "cannot request access to a support agent" });
  }
  const isProviderTarget = targetRole === "primary";
  // A clinician asking a clinician. Support→provider is the roster flow and is the point of that
  // path; clinician→clinician would create a link the roster UI has no row for and the approval UI
  // no button for, so it is refused here rather than rendered as something neither side can act on.
  if (asker === "primary" && isProviderTarget) {
    log(400, "unsupported_target");
    return json(400, { error: "cannot request access to another provider" });
  }

  // Idempotent: asking twice returns the standing link rather than stacking a second invited row for
  // the subject to approve or deny one at a time.
  const existing = (await deps.links.listForProvider(session.accountId)).find(
    (l) => l.ownerAccountId === target.id && l.status !== "revoked"
  );
  if (existing) {
    log(200);
    return json(200, { ok: true, linkId: existing.id, status: existing.status });
  }

  const link = await deps.links.create({
    ownerAccountId: target.id,
    providerAccountId: session.accountId,
    // Who asked, not who the route is named after. The patient's screen reads this column to decide
    // whether approval means wrapping a key or flipping a flag, so a hardcoded "support" here would
    // have made every clinician request unapprovable.
    role: asker,
    status: "invited",
    grantedBy: session.accountId,
  });
  const vault = isProviderTarget ? undefined : (await deps.listVaultsForOwner(target.id))[0];
  // The `support_*` pair is frozen — those rows are already on patients' screens and
  // `functions/_lib/erasure.ts` never deletes them, so reusing either name for a clinician's ask
  // would leave one name covering two events with nothing to tell them apart by. A clinician's ask
  // is a new event and gets a new name rather than being folded into a family whose prefix would
  // then be a lie. Written out here, as literals in one expression, because
  // `tests/unit/audit-chokepoint.test.ts` sweeps the tree for exactly this shape: a name reachable
  // only through a helper's return is a name that test cannot see, and the closed vocabulary is only
  // closed while it can see all of them.
  const action =
    asker === "support"
      ? isProviderTarget
        ? "support_provider_access_requested"
        : "support_access_requested"
      : "provider_access_requested";
  await deps.audit.insertAccessEvent({
    actorAccountId: session.accountId,
    subjectAccountId: target.id,
    vaultId: vault?.vaultId ?? null,
    action,
  });

  log(200);
  return json(200, { ok: true, linkId: link.id, status: "invited", target: isProviderTarget ? "provider" : "patient" });
}
