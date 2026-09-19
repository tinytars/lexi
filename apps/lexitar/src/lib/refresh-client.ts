// W15/3b.2 — browser side of the provider Finding refresh. POSTs the decrypted client to the
// streaming /api/refresh-finding relay, accumulates the Opus text, then reuses the exact CLI
// validate + assemble (finding-assemble) with SubtleCrypto hashes (staleness.ts twins) to build a
// ClientFinding identical to a prod CLI regen. The retry-with-correction loop is browser-driven:
// on a parse/validate miss, re-POST with the correction (the same 6-attempt discipline as the CLI).
import type { Client, ClientFinding } from "./types";
import { orchestrateRefresh, type OrchestratedRefresh, type RefreshStage } from "./finding-refresh";
import { fetchLeafRegen, applyLeafRegen } from "./leaf-regen-client";
import {
  extractJson,
  validateFindingWithInputs,
  assembleFinding,
  FINDING_PORTION_KEYS,
  type FindingAIResponse,
} from "@pablotech/akesi/finding-assemble";
import { findingInputsHash, nodeHashes } from "./staleness";
import { CORE_BRAIN } from "./finding-config";
import { modelId } from "./model-config";
import { BRAIN_VERSIONS } from "./brain-versions";
import { plannedLabels, populatedNoteEntries } from "@pablotech/akesi/finding-generate";

const SENTINEL = "[[REFRESH_ERROR]]";
// W39: 3, not 6. Worst case is 3 full Opus generations, and only a *validation* miss burns a retry —
// a truncated/unparseable stream is terminal (see refreshFinding), so a Cloudflare cut can't loop.
const MAX_ATTEMPTS = 3;

export interface RefreshError extends Error {
  errorCode?: string;
}

// W39/Phase 2 — portion-based progress. `received` = how many of the Finding's top-level sections
// have appeared in the streamed buffer so far; `total` = FINDING_PORTION_KEYS.length. `attempt`/
// `maxAttempts` make a validation-retry read as a retry (bar resets, attempt increments) instead of
// the old KB counter's mysterious reset-to-zero.
export interface RefreshProgress {
  received: number;
  total: number;
  attempt: number;
  maxAttempts: number;
}

// W39/Phase 3 — loop-level events the browser reports to the server audit trail (POST /api/log). These
// are the decisions the server can't see: why a retry happened, when the loop gave up, a cancel. Never
// carries the correction prose — only a `reasonCategory`.
export interface RefreshEvent {
  event: "validation-fail" | "truncated" | "gave-up" | "success" | "cancelled";
  attempt: number;
  reasonCategory?: string;
  errorCode?: string;
}

// Fire-and-forget beacon to the PHI-free R2 audit sink. A log failure must never affect the refresh
// UX, so errors are swallowed. Callers (App.svelte) pass this as refreshFinding's onEvent handler and
// also fire it for outcomes observed outside the loop (a provider cancel).
export function logRefreshEvent(token: string, ev: RefreshEvent): void {
  void fetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(ev),
  }).catch(() => {});
}

// W39/Phase 4 — a persisted audit entry as read back from GET /api/logs (the PHI-free R2 trail the
// refresh Function + the loop beacon wrote). Mirrors the server AuditEntry — shape/outcome/cost only,
// never client bytes or prose. Drives the provider-only Diagnostics panel.
export interface RefreshLogEntry {
  at: string;
  event: string;
  status: number;
  attempt?: number;
  chars?: number;
  usage?: { input: number; output: number };
  errorCode?: string;
  reasonCategory?: string;
  latencyMs?: number;
  requestId?: string;
}

// Fetch the newest refresh audit entries (newest-first) for the Diagnostics panel. Provider-gated by
// the same token as the refresh itself. Throws on a non-2xx so the panel can surface why.
export async function fetchRefreshLog(token: string, limit = 100): Promise<RefreshLogEntry[]> {
  const res = await fetch(`/api/logs?route=refresh-finding&limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`logs unavailable (${res.status})`);
  return (((await res.json()) as { entries?: RefreshLogEntry[] }).entries ?? []);
}

// Count how many expected top-level keys are present in the partial buffer. Cheap substring scan for
// the quoted key (`"studyResults"`) — never a full JSON parse of partial text. The model emits
// sections roughly in schema order, so the count climbs monotonically within an attempt.
function countPortions(text: string): number {
  let n = 0;
  for (const key of FINDING_PORTION_KEYS) {
    if (text.includes(`"${key}"`)) n++;
  }
  return n;
}

function expectedFor(client: Client): { patient: string[]; planActions: string[]; noteIds: string[] } {
  const plannedActions = plannedLabels(client, new Date().toISOString().slice(0, 10));
  return {
    patient: [
      ...(client.factors?.decisions ?? []).map((d) => d.intervention.trim()),
      ...plannedActions,
    ],
    planActions: plannedActions,
    noteIds: populatedNoteEntries(client).map((n) => n.id),
  };
}

// Stream one attempt; returns the accumulated text. Throws a RefreshError on a pre-stream failure
// (401/402/429/…) or the in-band [[REFRESH_ERROR]] sentinel (post-header Anthropic/credit error).
async function streamAttempt(
  client: Client,
  corrections: string[],
  token: string,
  attempt: number,
  onProgress?: (p: RefreshProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("/api/refresh-finding", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ client, corrections, attempt }),
    signal,
  });
  if (!res.ok || !res.body) {
    let payload: { error?: string; errorCode?: string } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON */
    }
    const err = new Error(payload.error || `refresh failed (${res.status})`) as RefreshError;
    err.errorCode = payload.errorCode;
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    onProgress?.({
      received: countPortions(text),
      total: FINDING_PORTION_KEYS.length,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
    });
  }
  const at = text.indexOf(SENTINEL);
  if (at >= 0) {
    const err = new Error(text.slice(at + SENTINEL.length).trim() || "generation failed") as RefreshError;
    err.errorCode = "generation_failed";
    throw err;
  }
  return text;
}

// Refresh the Finding for `client`. Returns the assembled ClientFinding (caller merges + saves).
// onProgress reports portion-based progress (N of M sections, current attempt) to drive the button's
// segmented bar + "Attempt k of K" indicator.
export async function refreshFinding(
  client: Client,
  token: string,
  onProgress?: (p: RefreshProgress) => void,
  signal?: AbortSignal,
  onEvent?: (e: RefreshEvent) => void,
): Promise<ClientFinding> {
  const expected = expectedFor(client);
  // W72 — EVERY prior rejection, accumulated, matching the CLI. Sending only the latest is what made
  // a real refresh burn all six attempts: the model fixed each named problem and broke a different
  // one, never seeing the list. finding-generate.ts's correctionSuffix owns the wording.
  const corrections: string[] = [];
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // A transport/auth/credit failure (streamAttempt throws with an errorCode) is terminal — don't
    // burn retries on it. Ditto an abort (AbortError propagates straight out).
    const text = await streamAttempt(client, corrections, token, attempt, onProgress, signal);

    // W39: parse is TERMINAL, validation is RETRYABLE. If no complete JSON object came back the
    // stream was cut off (Cloudflare CPU/wall limit or a max_tokens truncation), not a fixable
    // content error — a correction can't un-truncate it, so retrying would just burn another full
    // generation. Only a well-formed candidate that fails *validation* earns a correction retry.
    let candidate: FindingAIResponse;
    try {
      candidate = JSON.parse(extractJson(text)) as FindingAIResponse;
    } catch {
      onEvent?.({ event: "truncated", attempt, errorCode: "truncated" });
      const err = new Error(
        "the Translation response was cut off before it finished (truncated) — not retried, to avoid wasted cost",
      ) as RefreshError;
      err.errorCode = "truncated";
      throw err;
    }

    try {
      validateFindingWithInputs(candidate, expected);
      const [inputsHash, nh] = await Promise.all([findingInputsHash(client), nodeHashes(client)]);
      onEvent?.({ event: "success", attempt });
      return assembleFinding(candidate, {
        generatedAt: new Date().toISOString(),
        inputsHash,
        nodeHashes: nh,
        generatedBy: { mode: "prod", model: modelId("finding") },
        noteIds: expected.noteIds,
        promptVersions: { [CORE_BRAIN]: BRAIN_VERSIONS[CORE_BRAIN] },
      });
    } catch (e) {
      lastErr = e;
      corrections.push(String((e as Error).message).slice(0, 600));
      // A validation miss earns a correction retry. Report the CATEGORY only — never the correction
      // prose (it reasons about the patient → PHI-adjacent).
      onEvent?.({ event: "validation-fail", attempt, reasonCategory: "validation" });
    }
  }
  onEvent?.({ event: "gave-up", attempt: MAX_ATTEMPTS, errorCode: "validation_exhausted" });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * The whole refresh the provider's button runs: the core generation above, then every leaf.
 *
 * `refreshFinding` IS orchestrateRefresh's `generateCore` — that is the shape finding-refresh.ts was
 * written for, and until now nothing supplied it, so the orchestrator sat unused while the button
 * called the core alone. The leaf runner is the /api/leaf-regen relay the Translate buttons already
 * use, so a leaf regenerated by a whole-Finding refresh and one regenerated from its own ⋮ go
 * through exactly the same request, validation and merge.
 *
 * `save` is called after the core and after each leaf, not once at the end (see orchestrateRefresh):
 * a cancel or a crash mid-run then keeps everything that already succeeded. That is ~10 vault writes
 * per refresh rather than 1 — deliberate, and cheap next to the generation it protects.
 *
 * A leaf that fails is reported in `failures`, not thrown: one rate-limited node must not discard a
 * completed core and eight good leaves, and every leaf stays individually retryable from its own
 * Translate.
 */
export async function refreshFindingWithLeaves(
  client: Client,
  token: string,
  clientId: string | null,
  opts: {
    onProgress?: (p: RefreshProgress) => void;
    onStage?: (s: RefreshStage) => void;
    onEvent?: (e: RefreshEvent) => void;
    save?: (c: Client) => Promise<void>;
    signal?: AbortSignal;
    /**
     * The core generator, injected for the same reason orchestrateRefresh injects its own two: the
     * browser streams it through /api/refresh-finding (the default here), the CLI calls Anthropic
     * in-process. Overriding it is also what lets the wiring be unit-tested without a live stream.
     */
    generateCore?: () => Promise<ClientFinding>;
  } = {},
): Promise<OrchestratedRefresh> {
  const { onProgress, onStage, onEvent, save, signal, generateCore } = opts;
  return orchestrateRefresh(client, {
    generateCore: generateCore ?? (() => refreshFinding(client, token, onProgress, signal, onEvent)),
    runLeaf: async (c, node) => {
      // null = nothing populated for this node; leave what is already there rather than merging an
      // empty answer over it.
      const pending = await fetchLeafRegen(c, node, undefined, clientId, signal);
      return pending ? applyLeafRegen(c, pending, "refresh") : c;
    },
    save,
    onStage,
    signal,
  });
}
