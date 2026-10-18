// W71 — a stable, unguessable KDF salt for an account that does not exist.
//
// `/api/auth/password/salt` and `/api/auth/recovery/salt` are looked up by email before the login
// POST, because the client needs the salt to derive authHash. Both answered 404 for an unknown
// address and 200 for a known one, which made them user-enumeration oracles: anyone could test an
// email against the patient roster of a health application, unauthenticated and unlogged. That
// undid the uniform 401 `login.ts` is careful to return — the salt lookup had already told the
// caller which branch the login would take.
//
// The fix is to answer 200 either way. A decoy has to be:
//
//   - STABLE per email, or probing twice reveals it (a real salt does not change between requests);
//   - UNPREDICTABLE, or an attacker recognises the decoy by recomputing it, which is the oracle back
//     again wearing a 200;
//   - shaped exactly like a real one — same hex length, same iteration count.
//
// HMAC-SHA256 over the email under SESSION_SECRET satisfies all three: deterministic to us, opaque
// to anyone without the secret. Deriving it from the same secret the sessions use means there is no
// new key to provision or rotate.
//
// What this deliberately does NOT do is make the subsequent login succeed. A caller who derives a key
// from a decoy salt gets the same uniform 401 as a wrong password — the point is that the two are
// indistinguishable until then, not that a nonexistent account can be logged into.

/** The iteration count the browser mints real credentials with (auth-client.ts). */
export const KDF_ITERATIONS = 200_000;

const enc = new TextEncoder();

export async function decoySalt(secret: string, email: string, purpose: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${purpose}:${email.toLowerCase()}`)));
  // 16 bytes as hex — the shape auth-client.ts mints (bytesToHex over a 16-byte random salt).
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
