// M54/4 — browser side of treatment inference. Sends what the user has — captured photos, or the
// product's own sheet as pasted text — to the stateless /api/treatment-infer relay, which returns a
// best-guess record for the add/edit-treatment modal to prefill.
//
// Throws AiError, not a bespoke error type: the relay classifies every failure the same way
// leaf-regen does (insufficient_credit / ai_busy / invalid_inference / …), and there is one
// describeAiError that turns those into the sentence a person reads. This path used to build its own
// TreatmentImageError and then have the caller drop it and read `.message`, so credit exhaustion
// here looked nothing like credit exhaustion anywhere else.
import { bytesToBase64 } from "./base64";
import { AiError, withDeadline } from "./ai-error";
import { LEAF_REGEN_DEADLINE_MS } from "./leaf-regen-config";
import type { ProposedTreatment } from "@pablotech/akesi/treatment-infer";

export interface TreatmentInferInput {
  images?: { bytes: Uint8Array; mediaType: "image/jpeg" | "image/png" }[];
  text?: string;
}

export async function inferTreatmentRecord(input: TreatmentInferInput): Promise<ProposedTreatment> {
  const images = input.images ?? [];
  const text = input.text?.trim() ?? "";
  if (images.length === 0 && !text) throw new AiError("Add a photo or some text first.", { errorCode: "no_input" });

  // Bounded like every other inference call — see leaf-regen-client.ts. Without a deadline a hung
  // socket leaves "Identifying…" on screen forever with nothing to report.
  // /api/treatment-infer is gated by the hd_session cookie (W44) — same-origin fetch sends it.
  const res = await withDeadline(LEAF_REGEN_DEADLINE_MS, (signal) =>
    fetch("/api/treatment-infer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(images.length ? { images: images.map((i) => ({ base64: bytesToBase64(i.bytes), mediaType: i.mediaType })) } : {}),
        ...(text ? { text } : {}),
      }),
      signal,
    }).catch((e) => {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError("couldn't reach the AI service", { errorCode: "offline" });
    }),
  );

  const payload = (await res.json().catch(() => null)) as (ProposedTreatment & { error?: string; errorCode?: string }) | null;
  if (!res.ok) {
    throw new AiError(payload?.error || `treatment inference failed (${res.status})`, {
      errorCode: payload?.errorCode,
      status: res.status,
    });
  }
  return payload as ProposedTreatment;
}
