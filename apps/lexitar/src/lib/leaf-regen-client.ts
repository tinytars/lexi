// W15d — the generic browser side of a leaf regen: builds the DAG-driven context, calls the stateless
// /api/leaf-regen relay, validates + merges the result via the node's LEAF_REGEN_SPECS entry, and
// re-stamps that node's hash so its stale chip clears. The caller (App) just wraps the returned Client
// in a new Vault and persists — it does not need to know per-node merge details.

import type { Client, RegenEvent } from "./types";
import { LEAF_REGEN_SPECS, leafContextFor, mergeLeafResult, validateLeafResult } from "./leaf-regen-registry";
import { nodeHashNow } from "./staleness";
import { appendRegenEvent } from "./regen-log";
import { visionAttachmentsFor, documentAttachmentsFor } from "./finding-vision";
import { fetchAttachmentBase64, MAX_VISION_ATTACHMENTS } from "./attachment-store";
import { documentTextsFor } from "./document-extract-client";
import { MAX_LEAF_DOCUMENTS } from "./leaf-regen-config";
import type { DocumentText } from "@pablotech/akesi/document-read";
import { AiError, withDeadline } from "./ai-error";
import { LEAF_REGEN_DEADLINE_MS } from "./leaf-regen-config";

// A leaf-regen result that has been fetched + validated but not yet merged into a client — the
// merge (applyLeafRegen) is deferred so the caller can apply it against whatever client is live at
// save time, not necessarily the same snapshot used to build the request context.
export interface PendingLeafRegen {
  node: string;
  validated: unknown;
  // Carried through to applyLeafRegen's mergeInto call — see leaf-regen-registry.ts's
  // LeafRegenSpec.mergeInto comment for why a scoped (targetIds-filtered) response must be paired
  // against these same ids, not the full populated list.
  targetIds?: string[];
  // The node's input hash AT REQUEST TIME — i.e. the state `validated` actually answers. applyLeafRegen
  // stamps nodeHashes from this, not from whatever client is live at merge time: a concurrent edit can
  // land during the round-trip this took, and stamping against the (now newer) live input would mark
  // the node fresh even though its content still answers the OLDER state — masking the drift instead
  // of leaving it stale for the next trigger/sweep to pick up.
  inputHash: string;
}

// Returns null when the node's context is empty (nothing to regenerate) — the caller leaves the
// existing value in place. Throws on a missing spec, or a transport / relay error, so the caller can
// retry on the next edit (mirroring refreshTreatmentGroups).
//
// targetLabels narrows the row(s) the model is asked to answer (e.g. just the Study/Treatment row
// that was actually added or edited) instead of every populated row in the node — full context is
// still sent unscoped, so cross-row reasoning (dedup, ordering) is unaffected; only the requested
// output shrinks, which is what keeps a large patient's response from truncating past max_tokens.
// Omit it (or pass an empty array) to answer every populated row, as before.
//
// `client` here is only ever used to build the outgoing request (its snapshot of factors/finding at
// call time) — it is NOT the client the result gets merged into. See applyLeafRegen.
export async function fetchLeafRegen(
  client: Client,
  node: string,
  targetLabels?: string[],
  clientId?: string | null,
  signal?: AbortSignal,
): Promise<PendingLeafRegen | null> {
  const spec = LEAF_REGEN_SPECS[node];
  if (!spec) throw new Error(`no LEAF_REGEN_SPECS entry for node "${node}"`);

  const context = leafContextFor(node, client, targetLabels);
  if (spec.isEmpty?.(context)) return null;

  // W46 Phase 7 — treatmentAssessment/diseaseResults only (finding-vision.ts's closed whitelist):
  // fetch each attachment's bytes back from raw storage (same /api/raw endpoint AttachmentViewer
  // uses) and base64 them for the relay to fold into real Anthropic `image` content blocks. Needs
  // `clientId` (the lowercase R2/raw key, distinct from `client.displayName`) — omitted entirely
  // when absent, same as any other regen call from a context without a selected client.
  let images: { mediaType: string; base64: string }[] | undefined;
  if (clientId) {
    const attachments = visionAttachmentsFor(node, context, MAX_VISION_ATTACHMENTS);
    if (attachments.length > 0) {
      // allSettled, not all: an attachment whose bytes can't be fetched (deleted blob, a key that
      // never made it to this environment, a transient 5xx) must NOT take the regen down with it.
      // Under Promise.all one 404 rejected before the relay was ever called, so the node's Translate
      // failed with an error about a photo — and the background sweep that would have retried it hit
      // the single-flight lock and was dropped, leaving the leaf silently un-regenerated. The photos
      // are an enhancement; the assessment is the deliverable, so a missing one degrades to text.
      const settled = await Promise.allSettled(
        attachments.map(async (a) => ({ mediaType: a.mediaType, base64: await fetchAttachmentBase64(clientId, a.key) })),
      );
      const usable = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (usable.length < attachments.length) {
        console.warn(`leaf-regen(${node}): ${attachments.length - usable.length} attachment(s) unavailable — continuing without them`);
      }
      images = usable.length > 0 ? usable : undefined;
    }
  }

  // The documents attached to this node's own rows, as text extracted once at attach time. Every
  // leaf that answers a patient turn is eligible (finding-vision.ts's DOCUMENT_SOURCES); the
  // monolith core is not, and does not go through this client at all. documentTextsFor drops
  // anything unextracted or unfetchable, so a document that failed to read degrades this call to
  // text-and-images rather than failing it — same reasoning as the allSettled above.
  let documents: DocumentText[] | undefined;
  if (clientId) {
    const attached = documentAttachmentsFor(node, context, MAX_LEAF_DOCUMENTS);
    if (attached.length > 0) {
      const texts = await documentTextsFor(clientId, attached);
      if (texts.length > 0) documents = texts;
    }
  }

  // targetLabels is only sent to the relay for nodes with a scopedArrayKey (content-based SCOPE
  // OVERRIDE — treatmentAssessment/studyResults/hypothesisEvaluation). noteResults/familyResults/
  // allergyResults instead pre-filter `context` above (buildContext already applied targetLabels as
  // targetIds) — the model only ever sees the target row(s), so no prompt scope note is needed, and
  // sending one would just be noise (these ids are opaque, not content the model could match on).
  const sendTargetLabels = targetLabels && targetLabels.length > 0 && !!spec.scopedArrayKey;

  const payload = JSON.stringify({
    node,
    inputs: context,
    ...(sendTargetLabels ? { targetLabels } : {}),
    ...(images ? { images } : {}),
    ...(documents ? { documents } : {}),
  });

  // Bounded, always. Without a deadline a hung socket never settles, the caller's `finally` never
  // runs, and the button sits on "Translating…" forever with nothing to report — the actual bug this
  // milestone exists to fix. The abort also propagates to the Function, which passes it to the SDK.
  //
  // /api/leaf-regen is gated by the hd_session cookie (W44) — same-origin fetch sends it automatically.
  const res = await withDeadline(
    LEAF_REGEN_DEADLINE_MS,
    (deadlineSignal) =>
      fetch("/api/leaf-regen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: deadlineSignal,
      }).catch((e) => {
        if ((e as Error).name === "AbortError") throw e;
        throw new AiError(`leaf-regen(${node}) could not reach the server`, { errorCode: "offline" });
      }),
    signal,
  );

  // res.json(), not res.text(): the relay classifies every failure into a machine-readable errorCode
  // (insufficient_credit / ai_busy / anthropic_error / invalid_leaf_regen), and reading the body as
  // text threw that away, leaving the UI to render raw JSON where it should render a sentence.
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string; errorCode?: string } | null;
  if (!res.ok) {
    throw new AiError(body?.error || `leaf-regen(${node}) failed (${res.status})`, {
      errorCode: body?.errorCode,
      status: res.status,
    });
  }
  const resp = (body ?? {}) as { result: unknown };
  // Defensive: the relay already ran this. It re-runs here against the SAME context the request was
  // built from (the local above), which is the reference set the id checks need — not the client
  // that will be live at applyLeafRegen time.
  const inputHash = await nodeHashNow(client, node);
  return {
    node,
    validated: validateLeafResult(node, resp.result, context, sendTargetLabels ? targetLabels : undefined),
    targetIds: targetLabels,
    inputHash,
  };
}

// M55/M56 stale-draft-clobber fix — merges a fetched-but-not-yet-applied regen result into `client`.
// Call this with whatever client is live right before saving, not the (possibly now-stale) client
// passed to fetchLeafRegen: the network round-trip in fetchLeafRegen can take long enough for a
// concurrent edit to land and save in the meantime, and merging onto that old snapshot here would
// silently revert it when this regen's own save follows.
export async function applyLeafRegen(
  client: Client,
  pending: PendingLeafRegen,
  // W72 — which operation asked. Required rather than defaulted: the two callers are a single
  // Translate and a whole-Finding refresh, and a default would silently label one of them as the
  // other for as long as nobody checked.
  triggeredBy: RegenEvent["triggeredBy"],
): Promise<Client> {
  const merged = mergeLeafResult(client, pending.node, pending.validated, pending.targetIds);
  const stamped = {
    ...merged,
    finding: { ...merged.finding!, nodeHashes: { ...merged.finding!.nodeHashes, [pending.node]: pending.inputHash } },
  };
  // `client` is the pre-merge snapshot this regen is actually replacing — the same one mergeLeafResult
  // was given, not the request-time snapshot fetchLeafRegen used. Logging against the wrong one would
  // record a "before" that was never on screen.
  return appendRegenEvent(client, stamped, pending.node, triggeredBy);
}
