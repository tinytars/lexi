// The one safe Uint8Array → ArrayBuffer conversion, re-exported for the Functions layer.
//
// W72 introduced this helper here because `subtle.importKey("raw", …)` is typed for `BufferSource`
// and several call sites were satisfying it with `bytes as unknown as ArrayBuffer`. At runtime that
// works, because WebCrypto accepts a Uint8Array — which is exactly what makes the cast dangerous
// rather than merely ugly: it type-checks a claim that is false, and the day one of those functions
// returns a SUBARRAY (a view with a non-zero byteOffset, as `.subarray()` and many parsers produce)
// the import silently reads the whole backing buffer instead of the intended slice. A wrong key,
// imported without error.
//
// It was written out a third time here only because functions/_lib should not reach into src/. Later
// in W72 the shared home arrived, so the rule now has exactly one statement of it and this file is
// the Functions layer's door to it.
export { toArrayBuffer } from "@tinytars/vault/bytes";
