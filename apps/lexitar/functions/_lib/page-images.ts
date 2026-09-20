// Validate the rendered pages a browser sends when the configured model can see but cannot take a
// PDF (src/lib/pdf-pages-for-model.ts). Shared by both extract routes so the accepted shape cannot
// drift between them — this is a system boundary, and the body is attacker-controlled.
import type { PageImage } from "@pablotech/akesi/report-extract";

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export function validatePageImages(raw: unknown): PageImage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const pages: PageImage[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") return null;
    const { base64, mediaType } = p as Record<string, unknown>;
    if (typeof base64 !== "string" || !base64) return null;
    if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.includes(mediaType)) return null;
    pages.push({ base64, mediaType });
  }
  return pages;
}
