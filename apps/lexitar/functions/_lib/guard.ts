// Shared bearer-token guard for Pages Functions. W4 (/api/chat) and W6 (/api/vault)
// both gate on a constant-time compare against a Pages secret — keep one impl.

const enc = new TextEncoder();

// Length-guarded constant-time compare. Workers has no Node crypto.timingSafeEqual,
// so XOR-accumulate over equal-length byte arrays. Differing length short-circuits
// (length is not itself secret here).
function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

// Returns a 401 Response to short-circuit on a missing/bad bearer, or null to proceed.
// Without this the deployed route is an open relay on a public URL.
//
// `expectedToken` is a comma-separated allowlist: the request passes if its bearer
// matches ANY entry (constant-time). W4 chat sets several derived per-passphrase hashes;
// W6's single VAULT_TOKEN is just a 1-element list (tokens are base64url/hex — no commas).
export function requireBearer(request: Request, expectedToken: string | undefined): Response | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  const allowed = (expectedToken ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!match || allowed.length === 0 || !allowed.some((t) => timingSafeEqual(match[1], t))) {
    return unauthorized();
  }
  return null;
}
