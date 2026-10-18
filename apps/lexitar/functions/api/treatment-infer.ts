import type { D1Database } from "../_lib/identity-types";
import { requireSession } from "../_lib/session";
import { logRequest } from "../_lib/log";
import { modelErrorReply } from "../_lib/model-errors";
import { unattachedModelFor } from "../_lib/inference/attach";
import { inferTreatment } from "@pablotech/akesi/treatment-infer";
import { TREATMENT_INFER_MAX_TOKENS, MAX_TREATMENT_TEXT_CHARS } from "../../src/lib/treatment-infer-config";

// M54/4 — treatment add-flow intake relay. The browser can't hold the Anthropic key, so it sends
// what the user has — up to 4 base64-encoded photos of a pill bottle/label, or the product's own
// sheet as pasted text — and this relay returns the validated {name, kind, description,
// ingredients, links}. Runs on the distinct chat key so it can't drain the Finding credit pool.
//
// ONE route for both inputs: the extraction task is the same whichever way the label arrives, and
// splitting it would mean two prompts to keep the label-amount rule in sync across. Only the model
// differs — vision work for photos, the cheaper tier for text that is already text.
//
// The patient's reports are NOT attached (CORPUS.md §6): a pill bottle is not in the record, and
// this route has no clientId to read a record against.
interface Env {
  SESSION_SECRET: string;
  // W71 — requireSession reads accounts.sessions_valid_from, so every gated route needs the binding.
  DB: D1Database;
}

const ROUTE = "/api/treatment-infer";
// A base64 photo inflates ~33%; 24 MB of body admits several MB-scale JPEGs across
// up to 4 images, well past any phone photo.
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_IMAGES = 4;

interface RawImage {
  base64?: unknown;
  mediaType?: unknown;
}

interface TreatmentInferBody {
  images?: unknown;
  text?: unknown;
}

function validateImages(raw: unknown): { base64: string; mediaType: "image/jpeg" | "image/png" }[] | null {
  if (!Array.isArray(raw)) return null;
  const images: { base64: string; mediaType: "image/jpeg" | "image/png" }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const img = entry as RawImage;
    if (typeof img.base64 !== "string" || img.base64.length === 0) return null;
    if (img.mediaType !== "image/jpeg" && img.mediaType !== "image/png") return null;
    images.push({ base64: img.base64, mediaType: img.mediaType });
  }
  return images;
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context;
  const start = Date.now();
  const requestId = request.headers.get("cf-ray") ?? undefined;

  const finish = (status: number, payload: unknown, extra: Partial<Parameters<typeof logRequest>[0]> = {}): Response => {
    logRequest({ route: ROUTE, status, latencyMs: Date.now() - start, requestId, ...extra });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };

  const session = await requireSession(request, env);
  if (session instanceof Response) {
    return finish(401, { error: "unauthorized" }, { errorCode: "unauthorized" });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return finish(413, { error: "request too large", errorCode: "too_large" }, { errorCode: "too_large" });
  }
  let body: TreatmentInferBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return finish(400, { error: "malformed JSON body", errorCode: "bad_json" }, { errorCode: "bad_json" });
  }

  // images is now OPTIONAL (text is the other way in), so `undefined` is fine and only a present-
  // but-malformed value is rejected — distinguishing "sent no photos" from "sent bad photos".
  const images = body.images === undefined ? [] : validateImages(body.images);
  if (!images) {
    return finish(400, { error: "images is malformed", errorCode: "no_images" }, { errorCode: "no_images" });
  }
  if (images.length > MAX_IMAGES) {
    return finish(
      400,
      { error: `at most ${MAX_IMAGES} images are allowed`, errorCode: "too_many_images" },
      { errorCode: "too_many_images" },
    );
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length > MAX_TREATMENT_TEXT_CHARS) {
    return finish(
      400,
      { error: `text must be at most ${MAX_TREATMENT_TEXT_CHARS} characters`, errorCode: "text_too_long" },
      { errorCode: "text_too_long" },
    );
  }
  if (images.length === 0 && !text) {
    return finish(400, { error: "photos or text are required", errorCode: "no_input" }, { errorCode: "no_input" });
  }

  try {
    // Photos are vision work; text that is already text is not, so each has its own feature.
    const { client, model } = unattachedModelFor(env, images.length > 0 ? "treatmentImage" : "treatmentText");
    const result = await inferTreatment(client, { images, text }, model, TREATMENT_INFER_MAX_TOKENS);
    return finish(200, result);
  } catch (err) {
    // A schema/validation failure from inferTreatment is the model's fault, not a transport error —
    // surface it as 422 so the browser says it couldn't read the source rather than blaming the network.
    const message = (err as Error).message ?? "";
    if (/^image inference truncated|^no text block|^invalid JSON for/.test(message)) {
      return finish(422, { error: "could not read this product", detail: message, errorCode: "invalid_inference" }, { errorCode: "invalid_inference" });
    }
    const { status, errorCode, error } = modelErrorReply(err, "image inference backend error");
    return finish(status, { error, errorCode }, { errorCode });
  }
}
