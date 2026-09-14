import type { Client } from "./types";
import { shouldResyncDraft } from "./client-resync";
import { normalizeClientDraft } from "@pablotech/akesi-pil/factors-edit";

export interface DraftSync {
  readonly draft: Client;
  // Call right before an immediate-persist mutation so the next `client` prop update (the
  // parent's own echo of the save) doesn't stomp `draft` with a resync — mirrors the
  // `skipNextResync = true` line every CRUD tab set inline before this extraction.
  skipNextResync(): void;
}

// Variant B (UnifiedTreatment/Study/Notes/FutureTreatment/HealthReports): `draft` starts and can
// return to null when `canEdit()` is false (a read-only host with no onSave never populates it).
export interface GatedDraftSync {
  readonly draft: Client | null;
  skipNextResync(): void;
}

// M97 §G Phase 1 (draft/resync half) — extracts the byte-for-byte-identical resync effect shared
// by all 9 CRUD tabs. Two call shapes, matching the two variants research found:
// - Variant A (Allergies/Family/Symptoms/Personalization): omit `canEdit` — `draft` is always a
//   live Client, never null, rebuilt via `build` whenever `shouldResyncDraft` says a real client
//   change landed.
// - Variant B (Study/Notes/UnifiedTreatment/FutureTreatment/HealthReports): pass `canEdit` —
//   `draft` is `Client | null`, and the resync effect nulls it out instead of building when
//   `canEdit()` is false (a read-only host with no `onSave` never gets a draft).
//
// First `.svelte.ts` runes-factory in this codebase (none existed before this phase) — kept
// deliberately minimal: only the resync mechanics move here, not persistNow/rowActions, which
// research (M97 plan Phase 7 notes) found has real per-entity divergence (anchor computation,
// targetLabels scoping, "never saved yet" guards) that doesn't safely generalize.
export function createDraftSync(getClient: () => Client, build: (c: Client) => Client, getSaveError: () => unknown): DraftSync;
export function createDraftSync(getClient: () => Client, build: (c: Client) => Client, getSaveError: () => unknown, canEdit: () => boolean): GatedDraftSync;
export function createDraftSync(
  getClient: () => Client,
  build: (c: Client) => Client,
  getSaveError: () => unknown,
  canEdit?: () => boolean,
): DraftSync | GatedDraftSync {
  let draft = $state<Client | null>(canEdit && !canEdit() ? null : build(getClient()));
  let lastClient: Client | null = getClient();
  let skip = false;

  $effect(() => {
    const c = getClient();
    if (c === lastClient) return;
    if (skip) { skip = false; lastClient = c; return; }
    const resync = shouldResyncDraft(lastClient, c);
    lastClient = c;
    if (!resync) return;
    if (canEdit && !canEdit()) { draft = null; return; }
    draft = build(c);
  });
  $effect(() => { if (getSaveError()) skip = false; });

  return {
    get draft() { return draft; },
    skipNextResync() { skip = true; },
  } as DraftSync | GatedDraftSync;
}

export function createPersistNow(
  ds: DraftSync | GatedDraftSync,
  getClient: () => Client,
  onSave: ((updated: Client) => void) | undefined,
  onSaved?: (anchor: string) => void,
  baseline: (c: Client) => Client = (c) => structuredClone($state.snapshot(c)) as Client,
) {
  return function persistNow(mutate: (payload: Client) => void, anchor?: string): void {
    const payload = baseline(getClient());
    mutate(payload);
    ds.skipNextResync();
    onSave?.(normalizeClientDraft(payload));
    if (anchor !== undefined) onSaved?.(anchor);
  };
}
