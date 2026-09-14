import { describe, it, expect } from "vitest";
import { generatePassphrase, withRosterPass } from "../../scripts/rotate-roster-pass";

// The point of the rotation is that the roster's secret collides with NOTHING. A generator that
// could emit a slug-shaped value, or a credentials-file writer that dropped the old line in place,
// would each quietly reinstate the collision — so both are pinned here rather than eyeballed once.

describe("the generated roster passphrase", () => {
  it("is long, unambiguous, and different every time", () => {
    const a = generatePassphrase();
    const b = generatePassphrase();
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
    // No l/I/0/O — these get transcribed by hand into a GitHub secret field.
    expect(a).toMatch(/^[a-zA-HJ-NP-Z2-9]+$/);
  });

  it("cannot collide with a slug: it is far longer than any identifier in the system", () => {
    // The exact defect being retired — PASSPHRASE was 4 characters and equal to the public slug.
    expect(generatePassphrase().length).toBeGreaterThan("fam4".length * 4);
  });

  it("draws on the whole alphabet rather than a biased slice", () => {
    // Non-vacuity: a generator returning one repeated character would pass every check above.
    const sample = Array.from({ length: 20 }, () => generatePassphrase()).join("");
    expect(new Set(sample).size).toBeGreaterThan(40);
  });
});

describe("writing it into the credentials file", () => {
  it("appends without disturbing the secrets already there", () => {
    const before = "PASSPHRASE=fam4\nORG_KEY_PASSPHRASE=xyz\n";
    const after = withRosterPass(before, "NEWPASS");
    expect(after).toContain("PASSPHRASE=fam4\n");
    expect(after).toContain("ORG_KEY_PASSPHRASE=xyz\n");
    expect(after).toMatch(/^ROSTER_PASS=NEWPASS$/m);
  });

  it("keeps the assignment parseable when the file did not end in a newline", () => {
    // load-creds.ts matches per line; a value glued onto the previous line is silently unreadable.
    const after = withRosterPass("PASSPHRASE=fam4", "NEWPASS");
    expect(after).toMatch(/^PASSPHRASE=fam4$/m);
    expect(after).toMatch(/^ROSTER_PASS=NEWPASS$/m);
  });
});
