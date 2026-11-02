# The laws LexiTar operates under

LexiTar is operated by the Tiny Tars Foundation, a Nevada nonprofit corporation and a
501(c)(3) public charity, from the United States. This document names the law that governs it, and
under each entry names the mechanism in the software that bears on that law and a file a reader can
open to check the mechanism is really there.

Five regimes are named below. Two of them are named in order to be **disclaimed** — the Health
Insurance Portability and Accountability Act and the Food and Drug Administration's device rules —
because a health product that stays silent about those two leaves a reader to guess, and the guess is
usually wrong in the product's favour. One entry is a **standard adhered to** rather than a law
claimed. **Nothing else is claimed.** No regime outside the United States is claimed, and no
certification, seal, audit or third-party attestation is held for any of them.

This document is the self-assessment's answer to indicator 7 of the Digital Public Goods Standard
(`DPGA.md`). It is a statement of what the software does, not legal advice, and it is not a
substitute for the Foundation's published privacy policy and terms at <https://tinytars.foundation>,
which are the documents a user agrees to.

## 1. Organization and governing law — Nevada

The Foundation is a **Nevada nonprofit corporation under NRS Chapter 82**, organized 2025-05-14 under
charter certificate B202505145716442 issued by the Nevada Secretary of State. It is a **501(c)(3)
public charity**, EIN 39-2278196, recognized by Internal Revenue Service determination letter dated
2025-10-14 (DLN 26053613006025), with exemption effective from the date of formation. It is exempt
from the Nevada state business licence fee as a 501(c) entity under **NRS Chapter 76**.

All four identifiers above are public and independently checkable — the EIN and the exemption through
the IRS Tax Exempt Organization Search at <https://apps.irs.gov/app/eos/>, and the charter through
the Nevada Secretary of State's business search at <https://esos.nv.gov/EntitySearch/OnlineEntitySearch>.
None of them is taken from this repository: the EIN is the one the application itself displays to
every user, at `src/lib/brand.ts:15`.

One inconsistency is stated rather than reconciled: this document names NRS Chapter 82 as the law the
entity is organized under, while the Foundation's published Terms of Service carry no governing-law
clause naming a state. The Terms are maintained outside this repository and change through their own
review; the fact is recorded here so a reader comparing the two documents finds the answer rather
than the discrepancy.

## 2. FTC Health Breach Notification Rule — 16 CFR Part 318

> "Each vendor of personal health records … shall notify each individual who is a citizen or resident
> of the United States whose unsecured PHR identifiable health information was acquired by an
> unauthorized person as a result of a breach of security."

This is the regime that **governs**. LexiTar holds health records on individuals' behalf and is not a
HIPAA covered entity (§4 below), which is precisely the position the Rule was written for.

**The mechanism.** The Rule obliges a breach notice to say *which individuals were affected*, and a
log of lifecycle events cannot answer that question. So the database carries a table whose stated
reason for existing is this Rule. `migrations/0003_support_audit.sql:1-3` names it in the migration's
own header, and `:6-15` is the table — `phi_access_events`, recording actor, subject, vault, action
and the consent it was taken under, and deliberately **no** patient-identifying content. Every
privileged read passes through one chokepoint, `functions/_lib/phi-audit.ts:92-109`, which writes the
row **before** the read is served and returns HTTP 503 rather than serving an unlogged one. That
fail-closed behaviour is safe only because a subject reading their own record is excluded from
logging, and `functions/_lib/phi-audit.ts:1-21` is where that trade is argued. The same rows are what
a patient sees on their own access screen, so the Rule's audit obligation and the product's
transparency feature are one mechanism rather than two.

**What holds it.** `tests/unit/audit-chokepoint.test.ts` asserts that every route reaching a third
party's record goes through that chokepoint, and `tests/unit/phi-audit.test.ts` pins the chokepoint's
own behaviour including the 503. A new route that reads someone else's record without logging it
fails the build.

**The reporting channel and the response times** the Rule's remediation obligations run against are
in `MODERATION.md:8-14`, quoted there verbatim from what the product tells a user as they file a
report, and pinned against the application's own strings by `tests/unit/brand.test.ts`.

**What leaves the deployment, and the basis for it.** Answering a question about a record means
sending the documents themselves to the company operating the language model. There is no
per-patient consent switch for that, and that is a recorded decision rather than an omission:
`src/lib/brand.ts:42-50` states it and gives the reason, and `CORPUS.md:366-394` is the mechanism.
The basis under this Rule is **authorized disclosure** — the processing is named, by category of
recipient, in the Foundation's published privacy policy, in the repository's root `SECURITY.md:59-60`
processor table, and in the application itself at `src/lib/Disclaimer.svelte:10`, which
`src/App.svelte:1246` renders unconditionally on every screen rather than behind a link. Four facts
that a notice of this kind usually softens are stated plainly in that text and pinned verbatim by
`tests/unit/brand.test.ts:49-55`: the documents go when a record is opened rather than when a
question is asked, whole documents rather than summaries, a copy persists in the provider's cache
after the session for about an hour, and there is no negotiated zero-retention agreement.
`tests/unit/brand.test.ts:57-60` fails the build if that text is ever edited to promise the user a
switch that only the operator has. Whether the send happens at all is the operator's `REPORTS`
setting, and `CORPUS.md:385` records that production runs it off.

## 3. Children's Online Privacy Protection Act — 15 U.S.C. §§6501–6506

COPPA reaches operators of services directed to, or knowingly collecting personal information from,
children under 13. LexiTar is **out of its reach by enforcement rather than by assertion**: the
service is for people aged **16 and over**, and the limit is checked before an account can be used.

**The mechanism.** `src/lib/age-limit.ts:13` is the single declaration of the floor and `:25-29` the
check. It runs in the browser, for a reason stated at `:5-9`: a birth year never reaches the server
at all — it is folded into the encrypted record before it leaves the page — so checking the age
server-side would mean newly transmitting a birth date, which costs more privacy than it buys. The
server stores only that the check ran and passed, in one nullable column whose header says in as many
words what it is not (`migrations/0016_age_attestation.sql:1-7`). `tests/unit/account-function.test.ts:52-54`
onward pins the server half: unset until attested, stamped by the attestation, and never moved by a
later one.

**The honest limit.** This is a **year-granular self-declaration, not a verified age**, and
`MODERATION.md:111-118` says so in those words so that the attestation column cannot be read as
proof of age. A report that an account belongs to a child is handled as an abusive-account report and
ends in the account erasure that document's §4 describes.

## 4. HIPAA — named, and not claimed

The Foundation is **not a HIPAA covered entity and not a business associate of one**. LexiTar receives
records from the individuals they belong to, not from a provider or a health plan, so the Health
Insurance Portability and Accountability Act does not reach the service. That is why §2's Rule is the
regime that governs: the two are alternatives, and a consumer health product that is outside HIPAA is
inside the FTC's Rule.

The consequence is stated where it matters rather than hidden. `API.md:250` and `:435` record that
the service holds no business associate agreement with the model provider and that HIPAA's protections
are therefore not what the data rests on. The root `SECURITY.md:59` says the same of the model
provider in the processor table — no such agreement and no negotiated zero-retention arrangement —
and `:60` goes further in the one place the picture is more favourable: Microsoft's speech service
*is* in scope under its own agreement, but whether this deployment's subscription has that agreement
in force is unconfirmed, so nothing user-facing claims it.

**No HIPAA compliance, certification or safe-harbour status is claimed.**

## 5. FDA — outside the device definition

LexiTar explains a person's own existing records to that person in plain language. Under the Food and
Drug Administration's Clinical Decision Support guidance, a tool that maps medical terms into plain
English for a patient, and does not diagnose, treat or direct care, is generally outside device
regulation. `LIABILITY.md:18-24` is that argument in full, including the case it is contrasted with —
software aimed at a clinician during a time-critical event, which is regulated precisely because of
automation bias — and this entry points at that document rather than restating it.

Two limits on this entry, both stated rather than smoothed over. The guidance's exemption is
*general* and is not a clearance, a determination or an opinion from the agency; no such thing has
been sought or obtained. And the positioning the argument rests on is held by the product's copy, not
only by its documentation: "decision support" is forbidden on every user-facing surface and
`tests/e2e/shell-nav.spec.ts:167-172` fails the build if the About dialog stops describing LexiTar as
a health literacy tool or starts describing it as decision support. That test's own stated reason is
a different obligation — the eligibility rule of the Google Ad Grant the Foundation holds, which
draws the same education-not-medicine line — and the two are named separately here because they are
two obligations that happen to point the same way, not one obligation cited twice.

## 6. Accessibility — a standard adhered to, not a law claimed

The target is **WCAG 2.1 level AA**, and it is a target the product measures itself against on every
run rather than a conformance claim.

**The mechanism, and its honest shape.** `tests/e2e/a11y.spec.ts:22-23` fixes the audited rule set to
WCAG 2.0 and 2.1, A and AA, deliberately as a closed list so that widening it has to be a decision
rather than a drift. `:63-69` is the part worth reading before believing anything: each surface
carries the number of violations measured on it, the run fails if that number goes **up**, and the
number is lowered as defects are fixed. Some of those numbers are not zero today. That is a
**ratchet** — "we did not make it worse" enforceable now, "we made it better" visible over time — and
the reasoning for preferring it to a zero-tolerance gate is at `:12-20`: a zero gate on an
application this size fails on its first day and is switched off within a week, after which it
protects nothing while appearing to. `tests/unit/a11y-static.test.ts` separately pins the specific
defects already fixed, in the places they were fixed, without needing a browser.

**The Americans with Disabilities Act and Section 508 are not claimed**, and neither is WCAG
conformance at any level.

## What this does not claim

- **No non-US regime.** LexiTar is operated from the United States by a Nevada charity, and no
  privacy or data-protection law outside the United States is claimed, relied on, or asserted to be
  met.
- **No HIPAA status.** Not a covered entity, not a business associate, no business associate
  agreement with the model provider, and no safe harbour.
- **No FDA clearance or determination.** The argument at `LIABILITY.md:18-24` is a reading of
  published guidance, not a ruling, and none has been sought.
- **No WCAG conformance.** A measured, declining baseline is not a conformance claim, and §6 is
  written so that nobody can mistake it for one.
- **No certification, seal, audit or attestation** against any regime named here, by any body. The
  evidence offered in this document is source code a reader can open and tests that fail the build;
  that is all it is.
- **No verified age.** §3's floor is a self-declaration at year granularity.
- **Nothing here is legal advice**, and none of it displaces the Foundation's published privacy
  policy and terms, which are what a user agrees to.

## Sources

- FTC Health Breach Notification Rule, 16 CFR Part 318 — <https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-318>
- Children's Online Privacy Protection Act, 15 U.S.C. §§6501–6506 — <https://www.law.cornell.edu/uscode/text/15/chapter-91>
- FDA, *Clinical Decision Support Software* guidance — <https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software>
- HIPAA, 45 CFR Parts 160 and 164 — <https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C>
- Nevada Revised Statutes Chapter 82 (nonprofit corporations) — <https://www.leg.state.nv.us/nrs/nrs-082.html>
- Nevada Revised Statutes Chapter 76 (state business licence) — <https://www.leg.state.nv.us/nrs/nrs-076.html>
- Web Content Accessibility Guidelines 2.1 — <https://www.w3.org/TR/WCAG21/>

Read 2026-11-02.

The self-assessment that cites this document is `DPGA.md`; indicator 7 is where it is used.
