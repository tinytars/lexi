// The thumbprint is what the re-key command compares a live public key against, so a wrong one
// means either refusing a safe key (annoying) or minting an envelope to a published one (the whole
// incident, again). These pin it against values computed independently of this implementation.
import { describe, it, expect } from "vitest";
import { canonicalEcJwk, jwkThumbprint } from "../../src/lib/jwk-thumbprint";
import compromised from "../../scripts/compromised-public-keys.json";

// The org principal's public key as migrations/0002 PUBLISHED it, 2026-09-14 to 2026-10-06,
// metadata members included. That file now seeds synthetic principals and this value no longer
// appears in it; it survives here because it is the key scripts/compromised-public-keys.json
// names, and the thumbprint below is the comparison that refuses an envelope to it. A public key
// reverses into nothing, which is why the list may be committed at all (its own safeToCommit note).
const ORG_AS_SEEDED: JsonWebKey = {
  key_ops: [],
  ext: true,
  kty: "EC",
  x: "GIngafJH7mS5RBOlbpYqec1-ftN0k4-uuzlCF6FPOrE",
  y: "OG92zKmmLVIWqZ5DojHGdJNKziA4Ur-wKmwqK7g5Zco",
  crv: "P-256",
} as JsonWebKey;

const byAccount = (id: string) => compromised.keys.find((k) => k.accountId === id)!;

describe("canonicalEcJwk", () => {
  it("keeps only crv/kty/x/y, in lexicographic order, unspaced", () => {
    expect(canonicalEcJwk(ORG_AS_SEEDED)).toBe(
      '{"crv":"P-256","kty":"EC","x":"GIngafJH7mS5RBOlbpYqec1-ftN0k4-uuzlCF6FPOrE","y":"OG92zKmmLVIWqZ5DojHGdJNKziA4Ur-wKmwqK7g5Zco"}',
    );
  });

  it("refuses a non-EC key rather than hashing the wrong member set", () => {
    expect(() => canonicalEcJwk({ kty: "RSA", n: "x", e: "AQAB" } as JsonWebKey)).toThrow(/expected an EC key/);
  });

  it("refuses an EC key missing a required member, naming which", () => {
    expect(() => canonicalEcJwk({ kty: "EC", crv: "P-256", x: "x" } as JsonWebKey)).toThrow(/missing y/);
  });
});

describe("jwkThumbprint", () => {
  it("matches the value recorded for the org key in the compromised list", async () => {
    expect(await jwkThumbprint(ORG_AS_SEEDED)).toBe(byAccount("00000000-0000-4000-8000-000000000001").thumbprint);
  });

  // This is the property the comparison rests on. A WebCrypto export carries key_ops and ext; the
  // SQL that seeded these keys carries them too but a re-exported key may not, and comparing JWK
  // objects would call those two different keys.
  it("ignores key_ops and ext, so one key has one name however it was exported", async () => {
    const stripped: JsonWebKey = { kty: "EC", crv: ORG_AS_SEEDED.crv, x: ORG_AS_SEEDED.x, y: ORG_AS_SEEDED.y };
    expect(await jwkThumbprint(stripped)).toBe(await jwkThumbprint(ORG_AS_SEEDED));
  });

  it("gives a different name to a different key", async () => {
    const other = { ...ORG_AS_SEEDED, x: "CYfjrp2lY1ksNECbIMknnfBPm-ASA9aDcw0LUSuWlH0" } as JsonWebKey;
    expect(await jwkThumbprint(other)).not.toBe(await jwkThumbprint(ORG_AS_SEEDED));
  });

  it("is 43 unpadded base64url characters", async () => {
    expect(await jwkThumbprint(ORG_AS_SEEDED)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("the compromised-key list", () => {
  it("names four keys and no duplicates, which is what migrations/0002 published until 2026-10-06", () => {
    expect(compromised.keys).toHaveLength(4);
    expect(new Set(compromised.keys.map((k) => k.thumbprint)).size).toBe(4);
    expect(new Set(compromised.keys.map((k) => k.accountId)).size).toBe(4);
  });

  it("carries no key material — only account ids and thumbprints", () => {
    for (const k of compromised.keys) {
      expect(Object.keys(k).sort()).toEqual(["accountId", "role", "thumbprint"]);
      expect(k.thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});
