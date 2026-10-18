// RFC 7638 JWK thumbprint, for naming a public key without printing it.
//
// Two call sites want the same thing for opposite reasons. The re-key command needs to ask "is this
// the key whose private half was published?" and must not answer it by comparing JWK objects —
// `key_ops` and `ext` travel with a WebCrypto export and differ between the browser that minted a
// key and the SQL that seeded one, so a field-by-field comparison reports two spellings of one key
// as two keys. And an operator report needs to name a key in a terminal that may be logged, where a
// 43-character hash is safe and a coordinate pair invites someone to reconstruct the point.
//
// Only crv/kty/x/y are hashed, which is the RFC's required member set for an EC key: everything
// else about a JWK is metadata about how it may be used, not about which key it is.

const REQUIRED = ["crv", "kty", "x", "y"] as const;

const b64url = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Canonical JSON of the members RFC 7638 requires for an EC key, lexicographic and unspaced. */
export function canonicalEcJwk(jwk: JsonWebKey): string {
  if (jwk.kty !== "EC") throw new Error(`jwk-thumbprint: expected an EC key, got kty=${JSON.stringify(jwk.kty)}`);
  const missing = REQUIRED.filter((k) => typeof (jwk as Record<string, unknown>)[k] !== "string");
  if (missing.length) throw new Error(`jwk-thumbprint: EC key is missing ${missing.join(", ")}`);
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

/** base64url(SHA-256(canonical JWK)), unpadded — the public name of a public key. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalEcJwk(jwk));
  return b64url(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}
