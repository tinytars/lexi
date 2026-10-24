import { describe, it, expect } from "vitest";
import {
  CLINICIAN_WINDOWS,
  KIND_CHIP,
  ROSTER_REQUEST,
  SUPPORT_WINDOWS,
  YOU_SENTENCE,
  grantSentence,
  grantedUntil,
  kindOf,
  pendingSentence,
  recoverySentence,
  rosterGrantSentence,
  untilPhrase,
  awaitingSentence,
  type Detail,
} from "../../src/lib/access-vocabulary";

// The owner's complaint, in their words: "it was really difficult to tell what was goin on between
// different support use cases and patients". The literal shape of it was a column value printed at
// a patient — a clinician row reading "Dr Smith primary", a support agent's reading "owner ·
// awaiting approval" — and the sentences below are what replaced it. They are values rather than
// markup precisely so this file can hold every one of them to the rule.

const NOW = Date.parse("2026-10-20T15:00:00Z");
const DAY = 86_400_000;
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString();
// Pinned so a CI box in another timezone reads the same month name as this machine.
const GB = "en-GB";

describe("the role column never reaches a patient", () => {
  it("says clinician where the database says primary", () => {
    expect(kindOf({ kind: "primary" })).toBe("clinician");
    expect(kindOf({ kind: "support" })).toBe("support");
  });

  // The regression test for the defect this work exists to fix. "support" is deliberately exempt
  // and the other two are not: it is the plain English word for who the person is, where "primary"
  // and "owner" are names for a stored value that mean nothing to the person reading them.
  it("no sentence and no chip label carries a raw column value", () => {
    const everything = [
      ...Object.values(KIND_CHIP).flatMap((c) => [c.label, c.title]),
      YOU_SENTENCE.text,
      pendingSentence({ kind: "primary" }).text,
      pendingSentence({ kind: "support" }).text,
      grantSentence({ expiresAt: null }, NOW, GB).text,
      grantSentence({ expiresAt: inDays(30) }, NOW, GB).text,
      grantSentence({ expiresAt: inDays(5) }, NOW, GB).text,
      grantSentence({ expiresAt: inDays(-1) }, NOW, GB).text,
      grantedUntil(inDays(30), NOW, GB),
      grantedUntil(null, NOW, GB),
      recoverySentence(true, null, 2, NOW, GB).text,
      recoverySentence(false, inDays(-300), 0, NOW, GB).text,
      ROSTER_REQUEST.text,
      rosterGrantSentence({ expiresAt: null }, NOW, GB).text,
      rosterGrantSentence({ expiresAt: inDays(-2) }, NOW, GB).text,
      untilPhrase(inDays(30), NOW, GB),
      untilPhrase(null, NOW, GB),
      awaitingSentence("owner"),
      awaitingSentence("provider"),
      ...CLINICIAN_WINDOWS.map((w) => w.label),
      ...SUPPORT_WINDOWS.map((w) => w.label),
    ];
    for (const s of everything) {
      expect(s, s).not.toMatch(/\bprimary\b/i);
      expect(s, s).not.toMatch(/\bowner\b/i);
    }
  });
});

describe("a grant says what its window means", () => {
  const text = (d: Detail) => d.text;

  it("a thirty-day grant names the date and the two ways out of it", () => {
    const d = grantSentence({ expiresAt: inDays(30) }, NOW, GB);
    expect(text(d)).toBe("Ends 19 Nov. You can renew or revoke at any time.");
    expect(d.tone).toBe("muted");
  });

  it("raises its voice inside the last week, and only there", () => {
    expect(grantSentence({ expiresAt: inDays(5) }, NOW, GB)).toEqual({ text: "Ends in 5 days (25 Oct).", tone: "warn" });
    expect(grantSentence({ expiresAt: inDays(7) }, NOW, GB).tone).toBe("warn");
    expect(grantSentence({ expiresAt: inDays(8) }, NOW, GB).tone).toBe("muted");
  });

  it("counts the last two days in words", () => {
    expect(text(grantSentence({ expiresAt: new Date(NOW + DAY).toISOString() }, NOW, GB))).toBe("Ends tomorrow (21 Oct).");
    expect(text(grantSentence({ expiresAt: new Date(NOW + 3 * 3_600_000).toISOString() }, NOW, GB))).toBe("Ends today (20 Oct).");
  });

  it("an ongoing grant says there is no end date rather than leaving the sentence out", () => {
    expect(text(grantSentence({ expiresAt: null }, NOW, GB))).toBe("Can read your record. No end date — until you revoke.");
  });

  it("an ended grant is in the past tense and says what it costs them", () => {
    expect(text(grantSentence({ expiresAt: inDays(-1) }, NOW, GB))).toBe("Ended 19 Oct. They can no longer read your record.");
  });

  it("carries the year once the date is not in this one", () => {
    expect(text(grantSentence({ expiresAt: inDays(120) }, NOW, GB))).toBe("Ends 17 Feb 2027. You can renew or revoke at any time.");
  });

  it("says the date is unreadable rather than inventing one", () => {
    expect(text(grantSentence({ expiresAt: "not a date" }, NOW, GB))).toBe("Can read your record. The end date could not be read.");
  });

  it("prints the clinician the same date the patient was shown", () => {
    const expires = inDays(30);
    expect(grantSentence({ expiresAt: expires }, NOW, GB).text).toContain("19 Nov");
    expect(grantedUntil(expires, NOW, GB)).toBe("Granted until 19 Nov");
    expect(grantedUntil(null, NOW, GB)).toBe("Granted with no end date");
  });
});

describe("the rows that are not a provider link", () => {
  it("asks for what each kind of asker is actually asking for", () => {
    expect(pendingSentence({ kind: "primary" }).text).toBe("Asked to read your record.");
    expect(pendingSentence({ kind: "support" }).text).toBe("Asked for temporary access to help you.");
  });

  it("tells the owner their own reading is not in the log below", () => {
    expect(YOU_SENTENCE.text).toBe("This is you. Your own reading is never listed below.");
  });

  it("counts the recovery key's uses, and says what removing it cost", () => {
    expect(recoverySentence(true, null, 0, NOW, GB).text).toBe("Can open your record if you lose your password. Never used.");
    expect(recoverySentence(true, null, 1, NOW, GB).text).toBe("Can open your record if you lose your password. Used once.");
    expect(recoverySentence(true, null, 4, NOW, GB).text).toBe("Can open your record if you lose your password. Used 4 times.");
    expect(recoverySentence(false, inDays(-290), 0, NOW, GB).text).toBe("Removed 3 Jan. Your password is the only key to this record.");
  });
});

describe("the clinician console says the same things about a roster", () => {
  it("counts the same window, about the thing that was actually granted", () => {
    expect(rosterGrantSentence({ expiresAt: null }, NOW, GB).text).toBe(
      "Can see your patient roster. No end date — until you revoke.",
    );
    expect(rosterGrantSentence({ expiresAt: inDays(-2) }, NOW, GB).text).toBe(
      "Ended 18 Oct. They can no longer see your roster.",
    );
  });

  // The two surfaces share one formatter precisely so this holds: a grant that ends on the 19th
  // must not be a record ending on the 19th and a roster ending on the 20th.
  it("dates a live window identically on both surfaces", () => {
    const expires = inDays(30);
    expect(rosterGrantSentence({ expiresAt: expires }, NOW, GB).text).toBe(
      grantSentence({ expiresAt: expires }, NOW, GB).text,
    );
    expect(untilPhrase(expires, NOW, GB)).toBe("until 19 Nov");
    expect(untilPhrase(null, NOW, GB)).toBe("no end date");
  });

  it("names who has not answered, never the column that says so", () => {
    expect(awaitingSentence("owner")).toBe("Waiting on this patient.");
    expect(awaitingSentence("provider")).toBe("Waiting on this clinician.");
  });

  it("offers the default the server also applies, first", () => {
    expect(CLINICIAN_WINDOWS[0]).toEqual({ label: "30 days", hours: 720 });
    expect(CLINICIAN_WINDOWS.map((w) => w.hours)).toContain(0);
    // Break-glass: no option here means "forever".
    expect(SUPPORT_WINDOWS.map((w) => w.hours)).toEqual([24, 72, 168]);
  });
});
