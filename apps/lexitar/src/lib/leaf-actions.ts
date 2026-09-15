// W46 Phase 2 — the one shared contract every leaf's LeafActionMenu items are built from, replacing
// eight copy-pasted `buildAttachment` functions (ChatTab, MarkerChart, HealthReports, Study,
// FutureTreatment, HypothesisTopicCard x3) and per-file hand-rolled item arrays that had drifted in
// both ordering and icon usage. Annotate went from present on 6 of ~12 leaf types to universal;
// Attach (W46 Phase 4) rides the same slot everywhere it lands.
import type { LeafMenuItem } from "@tinytars/frame/menu-items";
import type { Attachment, NoteAttachment } from "./types";
import type { Permalink } from "./permalink";
import { openAttachPicker, type AttachMode } from "@tinytars/frame/attach-controller";
import { attachFiles } from "./attachment-store";

export function buildNoteAttachment(
  kind: NoteAttachment["kind"],
  permalink: Permalink,
  preview: NoteAttachment["preview"],
): NoteAttachment {
  return { kind, permalink, preview };
}

// W46 Phase 4 — everything one leaf's "Attach" action needs: which client to upload under, where
// the uploaded Attachment[] should land, and how failures surface. `standardLeafActions` turns this
// into 1 menu item (fine pointer — a single "Attach" that opens the file/library chooser) or 3
// (coarse pointer — Take photo / Photo library / Choose file), all routed through the one shared
// hidden input (attach-controller.ts / AttachPicker.svelte) rather than each leaf owning its own.
export interface AttachTarget {
  clientId: string;
  accept?: string;
  maxCount?: number;
  onAttached: (attachments: Attachment[]) => void;
  onError?: (message: string) => void;
  // W50 — lets a caller intercept specific picked files before the generic attachFiles() upload,
  // e.g. Chat routing a picked PDF/XLSX through the full report-ingest pipeline (classifyUpload,
  // vault fold) instead of the generic un-processed /api/raw upload every other Attach use makes.
  // Return true to claim the file (attachTrigger won't touch it); false/omitted falls through to
  // attachFiles() as before. Unused by every other AttachTarget caller today.
  routeFile?: (file: File) => Promise<boolean>;
}

function attachTrigger(target: AttachTarget, mode: AttachMode): () => void {
  return () => {
    openAttachPicker(
      mode,
      async (files) => {
        try {
          let remaining = files;
          if (target.routeFile) {
            const claimed = await Promise.all(files.map((f) => target.routeFile!(f)));
            remaining = files.filter((_, i) => !claimed[i]);
          }
          if (remaining.length === 0) return;
          const attachments = await attachFiles(target.clientId, remaining, { maxCount: target.maxCount });
          target.onAttached(attachments);
        } catch (err) {
          target.onError?.(err instanceof Error ? err.message : "Attaching failed — try again.");
        }
      },
      target.accept,
    );
  };
}

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

export type LeafActionKey = "edit" | "chat" | "annotate" | "attach" | "preview" | "download" | "delete";

export interface StandardLeafActionsInput {
  edit?: () => void;
  chat?: () => void;
  annotate?: () => void;
  attach?: AttachTarget;
  preview?: () => void;
  download?: () => void;
  // Leaf-specific items (e.g. Reports' Download used to be the only secondary item) inserted
  // between Attach and Delete, in the canonical order documented at HealthReports.svelte:105-107:
  // Edit -> Chat -> Annotate -> Attach -> leaf-specific secondary -> Delete (danger last).
  extra?: LeafMenuItem[];
  delete?: () => void;
  // Per-leaf disable hook (owner decision, W46): default every action on; nothing sets this yet —
  // a later milestone turns individual items off where they prove meaningless on a given leaf.
  capabilities?: Partial<Record<LeafActionKey, boolean>>;
}

export function standardLeafActions(input: StandardLeafActionsInput): LeafMenuItem[] {
  const enabled = (key: LeafActionKey) => input.capabilities?.[key] !== false;
  const items: LeafMenuItem[] = [];
  if (input.edit && enabled("edit")) {
    items.push({ key: "edit", icon: "✎", label: "Edit", title: "Edit", onClick: input.edit });
  }
  if (input.chat && enabled("chat")) {
    items.push({ key: "chat", icon: "💬", label: "Chat", title: "Chat about this", onClick: input.chat });
  }
  if (input.annotate && enabled("annotate")) {
    items.push({ key: "annotate", icon: "📝", label: "Annotate", title: "Add a note about this", onClick: input.annotate });
  }
  if (input.attach && enabled("attach")) {
    const target = input.attach;
    if (isCoarsePointer()) {
      items.push({ key: "attach-camera", icon: "📷", label: "Take photo", onClick: attachTrigger(target, "camera") });
      items.push({ key: "attach-library", icon: "🖼", label: "Photo library", onClick: attachTrigger(target, "library") });
      items.push({ key: "attach-files", icon: "📎", label: "Choose file", onClick: attachTrigger(target, "files") });
    } else {
      items.push({ key: "attach", icon: "📎", label: "Attach", title: "Attach a photo or document", onClick: attachTrigger(target, "files") });
    }
  }
  if (input.preview && enabled("preview")) {
    items.push({ key: "preview", icon: "👁", label: "Preview", title: "Preview", onClick: input.preview });
  }
  if (input.download && enabled("download")) {
    items.push({ key: "download", icon: "⤓", label: "Download", title: "Download original", onClick: input.download });
  }
  if (input.extra) items.push(...input.extra);
  if (input.delete && enabled("delete")) {
    items.push({ key: "delete", icon: "🗑", label: "Delete", title: "Delete", danger: true, onClick: input.delete });
  }
  return items;
}
