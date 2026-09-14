// Extracted from UnifiedTreatment.svelte's saveNewTreatment (W79 phase 4b) — the compress → key →
// upload → collect loop over pending photo uploads. compressImage/buildAttachmentKey/uploadAttachment
// are injected so this accumulation logic (not the network/compression calls themselves) is testable.

import type { Attachment } from "./types";

export interface PendingImage {
  file: File;
  usedForIdentify?: boolean;
}

export interface AttachmentUploadDeps {
  compressImage: (file: File) => Promise<{ bytes: Uint8Array; mediaType: string }>;
  buildAttachmentKey: (bytes: Uint8Array, name: string) => Promise<string>;
  uploadAttachment: (clientId: string, bytes: Uint8Array, key: string) => Promise<void>;
  now?: () => string;
}

export interface AttachmentUploadResult {
  attachments: Attachment[];
  rawCaptureKeys: string[];
}

export async function uploadPendingImages(
  clientId: string,
  pendingImages: PendingImage[],
  deps: AttachmentUploadDeps,
): Promise<AttachmentUploadResult> {
  const attachments: Attachment[] = [];
  const rawCaptureKeys: string[] = [];
  const now = deps.now ?? (() => new Date().toISOString());
  for (const p of pendingImages) {
    const { bytes, mediaType } = await deps.compressImage(p.file);
    const key = await deps.buildAttachmentKey(bytes, p.file.name);
    await deps.uploadAttachment(clientId, bytes, key);
    attachments.push({ key, name: p.file.name, mediaType, bytes: bytes.length, addedAt: now() });
    if (p.usedForIdentify) rawCaptureKeys.push(key);
  }
  return { attachments, rawCaptureKeys };
}
