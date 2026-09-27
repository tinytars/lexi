// The browser half of POST /api/account/erase. The route has existed and been correct since W72;
// nothing in the product called it, so a user who asked to have their data deleted still could not.
// This is that call, and nothing more — the route owns the confirmation rule, the capability check
// and the plan of what to delete.
//
// The shape is declared here rather than imported from functions/_lib/erasure.ts because `src/` does
// not import from `functions/`: this is the wire contract as the browser needs to read it.
export interface ErasureOutcome {
  /** How many R2 objects were deleted. The keys themselves are of no use to the user. */
  deleted: number;
  /**
   * Objects in this account's namespaces that the server could not prove were this account's to
   * delete. Non-zero means the erasure was incomplete, and the user is told so in those words.
   */
  unattributable: number;
  complete: boolean;
}

export async function eraseMyAccount(confirmEmail: string): Promise<ErasureOutcome> {
  const res = await fetch("/api/account/erase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmEmail }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    r2Deleted?: string[];
    unattributable?: number;
    complete?: boolean;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? "Could not delete this account.");
  return {
    deleted: body.r2Deleted?.length ?? 0,
    unattributable: body.unattributable ?? 0,
    complete: body.complete === true,
  };
}

// DPG 9A.7 — what erasure does NOT reach, said in the same breath as what it does. Revoking the
// sessions kills the keepalive that keeps sending (erasure.ts), so nothing more leaves; the copy
// already written at the model provider expires on the provider's timetable and cannot be recalled.
// Stated in both branches because it is true of a complete erasure too — it is a limit of the world,
// not of the sweep.
export const ERASURE_REACH =
  "Copies of any reports already sent to the model provider expire on the provider's own schedule, " +
  "usually within about an hour; deleting your account stops anything further being sent but cannot " +
  "recall what it already holds.";

/** What the user is shown afterwards. Incompleteness is stated, never rounded up to "done". */
export function erasureSummary(outcome: ErasureOutcome): string {
  const files = `${outcome.deleted} ${outcome.deleted === 1 ? "file" : "files"}`;
  if (outcome.complete) return `Deleted. ${files} removed, along with your account and its history. ${ERASURE_REACH}`;
  return (
    `Deleted your account and ${files}. ${outcome.unattributable} ` +
    `${outcome.unattributable === 1 ? "file was" : "files were"} left in place because the server cannot ` +
    `prove they are yours to delete — they were uploaded before ownership was recorded, or another ` +
    `account wrote them first. Contact us and they will be removed by hand. ${ERASURE_REACH}`
  );
}
