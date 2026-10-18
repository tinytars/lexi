// W73 — the one comparison used to check a stored verifier, and the encoding it compares.
//
// This existed SIX times across `functions/`, spelled four different ways: sometimes reusing a
// module-level `enc`/`subtle`, sometimes constructing them inline, sometimes splitting the digest onto
// its own line. All six were correct, which is exactly why nobody consolidated them — and it is also
// why it matters. The constant-time compare is a security primitive whose failure mode is silent: a
// version that returned early on the first differing byte would pass every functional test in this
// repo and leak the verifier by timing. Six chances to get that wrong, in files nobody reads together.
//
// `tests/unit/recovery-invariants.test.ts` asserts there is exactly one implementation, derived from
// the tree, so a seventh cannot appear by being new.

const enc = new TextEncoder();
const subtle = (globalThis.crypto as Crypto).subtle;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url(SHA-256(s)) — the shape every stored verifier in this codebase is written in. */
export async function sha256Base64Url(s: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await subtle.digest("SHA-256", enc.encode(s) as BufferSource)));
}

/**
 * Length-guarded constant-time string compare.
 *
 * The length check short-circuits and therefore leaks LENGTH, which is fine here: every caller compares
 * fixed-width base64url digests, so the length carries no secret. It is not fine in general, and a
 * caller comparing variable-length secrets would need a different function.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
