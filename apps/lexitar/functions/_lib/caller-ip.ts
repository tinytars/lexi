/**
 * The caller's address as the platform reports it, or null when it reports none.
 *
 * Cloudflare always sets `cf-connecting-ip`; the Node host sits behind whatever proxy the deployment
 * has, so `x-forwarded-for` is the fallback and only its first entry is the client's. Extracted here
 * because three routes had their own copy and a fourth was about to: the budget modules key a bucket by
 * this value, so two of them disagreeing about what "the caller" means would split one attacker's
 * budget in half.
 */
export const callerIp = (request: Request): string | null =>
  request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
